import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Button,
  Divider,
  List,
  ListItem,
  ListItemText,
  Alert,
  LinearProgress,
  Chip,
  Card,
  CardContent,
  CardActions,
  Grid,
  IconButton,
  Tooltip,
  Select,
  MenuItem,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import * as turf from "@turf/turf";
import * as geojsonValidation from "geojson-validation";
import { z } from "zod";
import toast from "react-hot-toast";

const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
const WS_API_ENDPOINT =
  process.env.REACT_APP_WS_URL ||
  "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

// Enhanced validation schemas
const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  geojson: z.object({
    type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
    coordinates: z.array(z.any()),
  }),
  created_at: z.string().optional(),
});

const ZoneManager = () => {
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const fileInputRef = useRef(null);
  const zoneOverlaysRef = useRef([]);
  const lastZoneRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const assetMovementIntervalRef = useRef(null);
  const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

  // State management
  const [mapLoaded, setMapLoaded] = useState(false);
  const [zones, setZones] = useState([]);
  const [uploadStatus, setUploadStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [wsStatus, setWsStatus] = useState("Disconnected");
  const [assetPosition, setAssetPosition] = useState({
    lat: 40.7825,
    lng: -73.965,
  });
  const [inZone, setInZone] = useState(false);
  const [eventLog, setEventLog] = useState([]);
  const [allLogs, setAllLogs] = useState([]);
  const [currentZone, setCurrentZone] = useState(null);
  const [assetMoving, setAssetMoving] = useState(true);
  const [zoneVisibility, setZoneVisibility] = useState({});
  const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
  const [assetLocation, setAssetLocation] = useState(null);

  // Clear existing zone overlays from map
  const clearZoneOverlays = useCallback(() => {
    zoneOverlaysRef.current.forEach(({ overlay }) => {
      overlay?.setMap(null);
    });
    zoneOverlaysRef.current = [];
  }, []);

  // Load Google Maps API
  useEffect(() => {
    if (!window.google && !document.getElementById("google-maps-script")) {
      const script = document.createElement("script");
      script.id = "google-maps-script";
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
      script.async = true;
      script.defer = true;
      script.onload = () => setMapLoaded(true);
      script.onerror = () => {
        console.error("Failed to load Google Maps API");
        toast.error("Failed to load Google Maps API");
      };
      document.body.appendChild(script);
    } else if (window.google) {
      setMapLoaded(true);
    }
  }, []);
  const handleDrawingComplete = useCallback(async (event) => {
    let geojson;
    const name = prompt("Enter Zone Name");

    if (!name || name.trim() === "") {
      alert("Zone name cannot be empty.");
      event.overlay.setMap(null);
      return;
    }

    try {
      switch (event.type) {
        case "polygon": {
          const polygon = event.overlay;
          const path = polygon.getPath().getArray();
          if (path.length < 3) {
            throw new Error("Polygon must have at least 3 points.");
          }
          let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
          coordinates.push(coordinates[0]); // Close polygon

          geojson = {
            type: "Polygon",
            coordinates: [coordinates],
          };
          break;
        }

        case "polyline": {
          const polyline = event.overlay;
          const path = polyline.getPath().getArray();
          if (path.length < 2) {
            throw new Error("Line must have at least 2 points.");
          }
          const coordinates = path.map((latLng) => [
            latLng.lng(),
            latLng.lat(),
          ]);

          geojson = {
            type: "LineString",
            coordinates,
          };
          break;
        }

        case "circle": {
          const circle = event.overlay;
          const center = circle.getCenter();
          const radius = circle.getRadius();

          const points = [];
          const numPoints = 64;
          for (let i = 0; i < numPoints; i++) {
            const angle = (i / numPoints) * 2 * Math.PI;
            const point = turf.destination(
              turf.point([center.lng(), center.lat()]),
              radius / 1000,
              (angle * 180) / Math.PI,
              { units: "kilometers" }
            );
            points.push(point.geometry.coordinates);
          }
          points.push(points[0]);

          geojson = {
            type: "Polygon",
            coordinates: [points],
          };
          break;
        }

        case "rectangle": {
          const rectangle = event.overlay;
          const bounds = rectangle.getBounds();
          const ne = bounds.getNorthEast();
          const sw = bounds.getSouthWest();
          const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
          const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

          const coordinates = [
            [sw.lng(), sw.lat()],
            [nw.lng(), nw.lat()],
            [ne.lng(), ne.lat()],
            [se.lng(), se.lat()],
            [sw.lng(), sw.lat()],
          ];

          geojson = {
            type: "Polygon",
            coordinates: [coordinates],
          };
          break;
        }

        default:
          throw new Error("Unsupported shape type");
      }

      // Validate GeoJSON
      if (
        (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
        (geojson.type === "LineString" &&
          !geojsonValidation.isLineString(geojson))
      ) {
        throw new Error("Invalid GeoJSON shape. Please try again.");
      }

      // Remove the overlay from drawing manager (it will be redrawn by loadZones)
      event.overlay.setMap(null);

      await saveZone(name.trim(), geojson);
    } catch (error) {
      console.error("Drawing error:", error);
      alert(error.message);
      event.overlay.setMap(null);
    }
  }, []);
  const loadZones = useCallback(
    async (mapInstance) => {
      try {
        const res = await fetch(apiUrl("/zones"));
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();

        // Validate zones data
        const validatedZones = data.filter((zone) => {
          try {
            ZoneSchema.parse(zone);
            return true;
          } catch (error) {
            console.warn("Invalid zone data:", zone, error);
            return false;
          }
        });

        setZones(validatedZones);

        const map = mapInstance || mapInstanceRef.current;
        if (!map) return;

        // Clear existing zone overlays before adding new ones
        clearZoneOverlays();

        // Add new zone overlays
        validatedZones.forEach((zone) => {
          let overlay;

          if (zone.geojson.type === "Polygon") {
            overlay = new window.google.maps.Polygon({
              paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
                lat,
                lng,
              })),
              strokeColor: "#FF0000",
              strokeOpacity: 0.8,
              strokeWeight: 2,
              fillColor: "#FF0000",
              fillOpacity: 0.2,
            });
          } else if (zone.geojson.type === "LineString") {
            overlay = new window.google.maps.Polyline({
              path: zone.geojson.coordinates.map(([lng, lat]) => ({
                lat,
                lng,
              })),
              strokeColor: "#FF0000",
              strokeOpacity: 0.8,
              strokeWeight: 3,
            });
          }

          if (overlay) {
            overlay.setMap(map); // Show on map initially

            // ✅ Store with ID for future reference (e.g., toggling visibility)
            zoneOverlaysRef.current.push({ id: zone.id, overlay });

            // ✅ Track visibility status
            setZoneVisibility((prev) => ({
              ...prev,
              [zone.id]: true,
            }));

            // Add click listener for zone info
            overlay.addListener("click", () => {
              const infoWindow = new window.google.maps.InfoWindow({
                content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
              });

              const position =
                overlay.getPath?.().getAt(0) ??
                overlay.getPaths?.().getAt(0)?.getAt(0);

              if (position) {
                infoWindow.setPosition(position);
                infoWindow.open(map);
              }
            });
          }
        });
      } catch (err) {
        console.error("Failed to load zones:", err);
        toast.error("Failed to load zones");
      }
    },
    [clearZoneOverlays]
  );

  const initMap = useCallback(() => {
    if (!mapRef.current || !window.google || mapInstanceRef.current) return; // ✅ prevent re-init

    const map = new window.google.maps.Map(mapRef.current, {
      center: { lat: 40.7829, lng: -73.9654 },
      zoom: 15,
      mapTypeControl: true,
      streetViewControl: true,
      fullscreenControl: true,
    });

    mapInstanceRef.current = map;

    // ✅ Initialize drawing manager once
    const drawingManager = new window.google.maps.drawing.DrawingManager({
      drawingMode: null,
      drawingControl: true,
      drawingControlOptions: {
        position: window.google.maps.ControlPosition.TOP_CENTER,
        drawingModes: [
          window.google.maps.drawing.OverlayType.POLYGON,
          window.google.maps.drawing.OverlayType.POLYLINE,
          window.google.maps.drawing.OverlayType.CIRCLE,
          window.google.maps.drawing.OverlayType.RECTANGLE,
        ],
      },
      polygonOptions: {
        fillColor: "#2196F3",
        fillOpacity: 0.4,
        strokeWeight: 2,
        strokeColor: "#1976D2",
        clickable: true,
        editable: false,
        zIndex: 1,
      },
      polylineOptions: {
        strokeColor: "#2196F3",
        strokeWeight: 3,
        clickable: true,
        editable: false,
        zIndex: 1,
      },
      rectangleOptions: {
        fillColor: "#2196F3",
        fillOpacity: 0.4,
        strokeWeight: 2,
        strokeColor: "#1976D2",
        clickable: true,
        editable: false,
        zIndex: 1,
      },
      circleOptions: {
        fillColor: "#2196F3",
        fillOpacity: 0.4,
        strokeWeight: 2,
        strokeColor: "#1976D2",
        clickable: true,
        editable: false,
        zIndex: 1,
      },
    });

    drawingManager.setMap(map);

    // Handle drawing completion
    window.google.maps.event.addListener(
      drawingManager,
      "overlaycomplete",
      handleDrawingComplete
    );

    // ✅ Load zones after initializing map
    loadZones(); // Don't pass map instance — use ref inside loadZones
  }, [handleDrawingComplete, loadZones]);

  // Initialize map when loaded
  useEffect(() => {
    if (mapLoaded && mapRef.current && !mapInstanceRef.current) {
      initMap();
    }
  }, [mapLoaded, initMap]);

  const saveZone = useCallback(async (name, geojson) => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/zone"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, geojson }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(
          errorData.error || `HTTP ${res.status}: ${res.statusText}`
        );
      }

      const result = await res.json();
      console.log("Zone saved:", name);

      // Broadcast zone update via WebSocket
      // 🔄 Broadcast delete to other users
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            action: "default",
            type: "zone-update",
            zoneName: name,
            timestamp: new Date().toISOString(),
          })
        );
      }

      toast.success("Zone added successfully!");
      await loadZones(); // Reload zones
    } catch (err) {
      console.error("Failed to save zone:", err);
      toast.error(`Failed to save zone: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const sendEmailAlert = useCallback(async (eventType, zone, point) => {
    const timestamp = new Date().toISOString();

    const body = {
      type: eventType,
      zoneId: zone.id,
      zoneName: zone.name,
      geojson: zone.geojson,
      point: point.geometry.coordinates,
      timestamp,
    };

    try {
      const res = await fetch(apiUrl("/alert"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      console.log("✅ Email alert sent:", body);
      await logEventToDB(eventType, zone.name, zone.id, timestamp);
    } catch (err) {
      console.error("❌ Failed to send email alert:", err);
      toast.error("Failed to send alert");
    }
  }, []);

  const logEventToDB = useCallback(
    async (type, zoneName, zoneId, timestamp) => {
      try {
        const res = await fetch(apiUrl("/log-event"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        console.log("✅ Log saved to DB");
      } catch (err) {
        console.error("❌ Failed to save log to DB:", err);
      }
    },
    []
  );

  const handleDelete = async (zoneId) => {
    try {
      setLoading(true);

      // ✅ Delete request
      const response = await fetch(apiUrl(`/zone/${zoneId}`), {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete zone");
      }

      // ✅ Remove from map
      const remainingOverlays = zoneOverlaysRef.current.filter((z) => {
        if (z.id === zoneId) {
          z.overlay.setMap(null);
          return false;
        }
        return true;
      });
      zoneOverlaysRef.current = remainingOverlays;

      // ✅ Remove from UI
      setZones((prev) => prev.filter((z) => z.id !== zoneId));
      setZoneVisibility((prev) => {
        const newState = { ...prev };
        delete newState[zoneId];
        return newState;
      });

      // ✅ Broadcast WebSocket message
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            action: "default",
            type: "zone-delete",
            zoneId, // ✅ correct variable
          })
        );
      }

      console.log("✅ Deleted zone:", zoneId);
    } catch (err) {
      console.error("❌ Delete failed", err);
    } finally {
      setLoading(false);
    }
  };

  const handleFileUpload = useCallback(
    async (event) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      setLoading(true);
      let successCount = 0;
      let errorCount = 0;

      for (let file of files) {
        try {
          const text = await file.text();
          const json = JSON.parse(text);

          if (
            !geojsonValidation.isPolygon(json) &&
            !geojsonValidation.isMultiPolygon(json) &&
            !geojsonValidation.isLineString(json)
          ) {
            throw new Error(
              "Only Polygon, MultiPolygon, or LineString supported"
            );
          }

          const name =
            prompt(`Enter a name for zone in ${file.name}`) ||
            file.name.replace(".geojson", "");

          if (!name || name.trim() === "") {
            throw new Error("Zone name is required");
          }

          await saveZone(name.trim(), json);
          successCount++;
        } catch (err) {
          console.error(`Error processing ${file.name}:`, err);
          errorCount++;
          setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
        }
      }

      if (successCount > 0) {
        setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
      }
      if (errorCount > 0) {
        toast.error(`Failed to upload ${errorCount} files`);
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      setLoading(false);
    },
    [saveZone]
  );

  const fetchAllLogs = useCallback(async () => {
    try {
      const res = await fetch(apiUrl("/logs"));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      setAllLogs(
        data.sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        )
      );
    } catch (err) {
      console.error("Failed to fetch logs:", err);
      toast.error("Failed to fetch logs");
    }
  }, []);

  const toggleZoneVisibility = useCallback((zoneId) => {
    setZoneVisibility((prev) => {
      const newVisibility = !prev[zoneId];

      const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
      if (overlayObj && overlayObj.overlay) {
        overlayObj.overlay.setMap(
          newVisibility ? mapInstanceRef.current : null
        );
      }

      return {
        ...prev,
        [zoneId]: newVisibility,
      };
    });
  }, []);

  // Asset movement and geofencing logic
  // Asset movement and geofencing logic
  // Disable fake asset movement – now use only WebSocket-driven updates
  useEffect(() => {
    if (
      !mapLoaded ||
      !zones.length ||
      !mapInstanceRef.current ||
      !assetLocation
    )
      return;

    const newPos = {
      lat: assetLocation.lat,
      lng: assetLocation.lng,
    };

    const point = turf.point([newPos.lng, newPos.lat]);
    let matchedZone = null;

    for (let zone of zones) {
      if (zone.geojson.type === "Polygon") {
        try {
          const polygon = turf.polygon(zone.geojson.coordinates);
          if (turf.booleanPointInPolygon(point, polygon)) {
            matchedZone = zone;
            break;
          }
        } catch (error) {
          console.warn("Error checking zone intersection:", error);
        }
      }
    }

    const inside = Boolean(matchedZone);
    const wasInside = Boolean(lastZoneRef.current);
    const ts = new Date().toISOString();

    if (inside && !wasInside) {
      lastZoneRef.current = matchedZone;
      zoneEntryTimeRef.current = ts;
      setInZone(true);
      setCurrentZone(matchedZone);
      setEventLog((prev) => [
        { type: "Entered", zone: matchedZone.name, time: ts },
        ...prev.slice(0, 9),
      ]);
      toast.success(`🚧 Entered zone ${matchedZone.name}`);
      sendEmailAlert("ENTER", matchedZone, point);
      fetchAllLogs();
    } else if (!inside && wasInside) {
      const exitedZone = lastZoneRef.current;
      lastZoneRef.current = null;
      setInZone(false);
      setCurrentZone(null);

      const entryTime = new Date(zoneEntryTimeRef.current).getTime();
      const exitTime = new Date(ts).getTime();
      const durationMs = exitTime - entryTime;

      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      const durationStr = `${minutes}m ${seconds}s`;

      setEventLog((prev) => [
        {
          type: `Exited`,
          zone: exitedZone?.name || "Unknown",
          time: ts,
          duration: `Stayed for ${durationStr}`,
        },
        ...prev.slice(0, 9),
      ]);
      toast.success(
        `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
      );
      sendEmailAlert("EXIT", exitedZone || {}, point);
      fetchAllLogs();
    }

    if (!markerRef.current && mapInstanceRef.current) {
      markerRef.current = new window.google.maps.Marker({
        map: mapInstanceRef.current,
        title: "Live Asset Location",
        icon: {
          url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new window.google.maps.Size(40, 40),
        },
      });
    }

    if (markerRef.current) {
      markerRef.current.setIcon({
        url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
        scaledSize: new window.google.maps.Size(40, 40),
      });

      markerRef.current.setPosition(
        new window.google.maps.LatLng(newPos.lat, newPos.lng)
      );
    }
  }, [mapLoaded, assetLocation, zones, sendEmailAlert, fetchAllLogs]);

  // WebSocket connection management
  useEffect(() => {
    const connectWebSocket = () => {
      const socket = new WebSocket(
        "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
      );

      wsRef.current = socket;

      socket.onopen = () => {
        console.log("✅ WebSocket connected");
        setWsStatus("Connected");
      };

      socket.onclose = () => {
        console.warn("🔌 WebSocket disconnected. Reconnecting...");
        setWsStatus("Disconnected");
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
      };

      socket.onerror = (err) => {
        console.error("❌ WebSocket error", err);
        socket.close();
      };

      socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log("📨 WebSocket message received:", data);

          // ✅ Log raw lat/lng if present
          if (data.lat && data.lng) {
            console.log("🛰️ Incoming Location Data →", {
              lat: data.lat,
              lng: data.lng,
              type: data.type,
            });
          }

          // ✅ Match by type
          if (data.type === "assetLocationUpdate") {
            const { lat, lng } = data.data;

            console.log("📍 Updating marker position to →", lat, lng);

            setAssetLocation({ lat, lng });

            if (!markerRef.current && mapInstanceRef.current) {
              console.log("🆕 Creating marker for live asset");
              markerRef.current = new window.google.maps.Marker({
                map: mapInstanceRef.current,
                title: "Live Asset Location",
                icon: {
                  url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
                  scaledSize: new window.google.maps.Size(32, 32),
                },
              });
            }

            if (markerRef.current) {
              markerRef.current.setPosition(
                new window.google.maps.LatLng(lat, lng)
              );
              // mapInstanceRef.current.setCenter({ lat, lng });
            } else {
              console.warn("❌ Marker is still null");
            }
          } else {
            console.warn("🟡 Unhandled message type or missing `type`:", data);
          }
        } catch (err) {
          console.error("❌ Failed to parse WebSocket message:", err);
        }
      };
    };

    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, [loadZones]);

  // Load logs on component mount
  useEffect(() => {
    fetchAllLogs();
  }, [fetchAllLogs]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearZoneOverlays();
      if (assetMovementIntervalRef.current) {
        clearInterval(assetMovementIntervalRef.current);
      }
    };
  }, [clearZoneOverlays]);

  const toggleAssetMovement = useCallback(() => {
    setAssetMoving((prev) => !prev);
  }, []);

  const refreshZones = useCallback(() => {
    loadZones();
  }, [loadZones]);

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
      <Typography variant="h4" gutterBottom>
        🗺️ Zone Manager
      </Typography>

      {/* Status indicators */}
      <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
        <Chip
          label={`WebSocket: ${wsStatus}`}
          color={wsStatus === "Connected" ? "success" : "error"}
          variant="outlined"
          size="small"
        />
        <Chip
          label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
          color={assetMoving ? "primary" : "default"}
          variant="outlined"
          size="small"
        />
        {currentZone && (
          <Chip
            label={`In Zone: ${currentZone.name}`}
            color="success"
            variant="filled"
            size="small"
          />
        )}
      </Box>

      {/* Loading indicator */}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Map container */}
      <Box
        ref={mapRef}
        sx={{
          width: "100%",
          height: "500px",
          mb: 3,
          border: 1,
          borderColor: "grey.300",
          borderRadius: 1,
        }}
      />

      {/* Asset controls */}
      <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
        <Button
          variant="outlined"
          onClick={toggleAssetMovement}
          color={assetMoving ? "error" : "success"}
        >
          {assetMoving ? "Stop Asset" : "Start Asset"}
        </Button>
        <Button
          variant="outlined"
          onClick={refreshZones}
          startIcon={<RefreshIcon />}
        >
          Refresh Zones
        </Button>
      </Box>

      {/* File upload section */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            📂 Upload GeoJSON Zone
          </Typography>
          <input
            type="file"
            ref={fileInputRef}
            accept=".geojson,application/geo+json"
            onChange={handleFileUpload}
            multiple
            disabled={loading}
            style={{ marginBottom: "16px" }}
          />
          {uploadStatus && (
            <Alert
              severity={uploadStatus.startsWith("✅") ? "success" : "error"}
              sx={{ mt: 1 }}
            >
              {uploadStatus}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Divider sx={{ my: 3 }} />

      {/* Zones list */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            🗂️ Saved Zones ({zones.length})
          </Typography>

          {zones.length === 0 ? (
            <Typography color="text.secondary">
              No zones available. Draw zones on the map or upload GeoJSON files.
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {zones.map((zone) => (
                <Grid item xs={12} sm={6} md={4} key={zone.id}>
                  <Card variant="outlined">
                    <CardContent
                      sx={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <Box>
                        <Typography variant="subtitle1" gutterBottom>
                          {zone.name}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          Type: {zone.geojson.type}
                        </Typography>
                        {zone.created_at && (
                          <Typography variant="caption" color="text.secondary">
                            Created:{" "}
                            {new Date(zone.created_at).toLocaleDateString()}
                          </Typography>
                        )}
                      </Box>
                      <Box>
                        <label>
                          <input
                            type="checkbox"
                            checked={zoneVisibility[zone.id] ?? true}
                            onChange={() => toggleZoneVisibility(zone.id)}
                          />{" "}
                          Visible
                        </label>
                      </Box>
                    </CardContent>

                    <CardActions>
                      <Tooltip title="Delete zone">
                        <IconButton
                          color="error"
                          onClick={() => handleDelete(zone.id)}
                          disabled={loading}
                        >
                          <DeleteIcon />
                        </IconButton>
                      </Tooltip>
                    </CardActions>
                  </Card>
                </Grid>
              ))}
            </Grid>
          )}
        </CardContent>
      </Card>

      <Divider sx={{ my: 3 }} />

      {/* Event log */}
      <Grid container spacing={3}>
        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                📋 Recent Events
              </Typography>
              {eventLog.length === 0 ? (
                <Typography color="text.secondary">
                  No recent events.
                </Typography>
              ) : (
                <List dense>
                  {eventLog.map((event, idx) => (
                    <ListItem key={idx}>
                      <ListItemText
                        primary={`${event.type} - ${event.zone}`}
                        secondary={new Date(event.time).toLocaleString()}
                      />
                    </ListItem>
                  ))}
                </List>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card>
            <CardContent>
              <Typography variant="h6" gutterBottom>
                📜 Full Log History
              </Typography>

              {/* Zone Filter Dropdown */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Filter Logs by Zone:
                </Typography>
                <Select
                  size="small"
                  value={selectedZoneFilter}
                  onChange={(e) => setSelectedZoneFilter(e.target.value)}
                  displayEmpty
                  sx={{ minWidth: 200 }}
                >
                  <MenuItem value="All">All</MenuItem>
                  {zones.map((zone) => (
                    <MenuItem key={zone.id} value={zone.name}>
                      {zone.name}
                    </MenuItem>
                  ))}
                </Select>
              </Box>

              {/* Filtered Logs List */}
              {allLogs.length === 0 ? (
                <Typography color="text.secondary">No logs found.</Typography>
              ) : (
                <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
                  {allLogs
                    .filter(
                      (log) =>
                        selectedZoneFilter === "All" ||
                        log.zoneName === selectedZoneFilter
                    )
                    .slice(0, 50)
                    .map((log, idx) => (
                      <ListItem key={log.id || idx}>
                        <ListItemText
                          primary={`${log.type} - ${log.zoneName || "Unknown"}`}
                          secondary={new Date(log.timestamp).toLocaleString()}
                        />
                      </ListItem>
                    ))}
                </List>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Asset position debug info */}
      <Box sx={{ mt: 3 }}>
        <Typography variant="caption" color="text.secondary">
          Asset Position: {assetPosition.lat.toFixed(6)},{" "}
          {assetPosition.lng.toFixed(6)}
          {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
        </Typography>
      </Box>
    </Box>
  );
};

export default ZoneManager;

// import React, { useEffect, useRef, useState, useCallback } from "react";
// import {
//   Box,
//   Typography,
//   Button,
//   Divider,
//   List,
//   ListItem,
//   ListItemText,
//   Alert,
//   LinearProgress,
//   Chip,
//   Card,
//   CardContent,
//   CardActions,
//   Grid,
//   IconButton,
//   Tooltip,
//   Select,
//   MenuItem,
// } from "@mui/material";
// import DeleteIcon from "@mui/icons-material/Delete";
// import RefreshIcon from "@mui/icons-material/Refresh";
// import * as turf from "@turf/turf";
// import * as geojsonValidation from "geojson-validation";
// import { z } from "zod";
// import toast from "react-hot-toast";

// const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// const WS_API_ENDPOINT =
//   process.env.REACT_APP_WS_URL ||
//   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// function apiUrl(path) {
//   return `${API_BASE_URL}${path}`;
// }

// // Enhanced validation schemas
// const LatLngSchema = z.object({
//   lat: z.number().min(-90).max(90),
//   lng: z.number().min(-180).max(180),
// });

// const ZoneSchema = z.object({
//   id: z.string(),
//   name: z.string().min(1),
//   geojson: z.object({
//     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
//     coordinates: z.array(z.any()),
//   }),
//   created_at: z.string().optional(),
// });

// const ZoneManager = () => {
//   const mapRef = useRef(null);
//   const markerRef = useRef(null);
//   const mapInstanceRef = useRef(null);
//   const fileInputRef = useRef(null);
//   const zoneOverlaysRef = useRef([]);
//   const lastZoneRef = useRef(null);
//   const wsRef = useRef(null);
//   const reconnectTimeoutRef = useRef(null);
//   const assetMovementIntervalRef = useRef(null);
//   const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

//   // State management
//   const [mapLoaded, setMapLoaded] = useState(false);
//   const [zones, setZones] = useState([]);
//   const [uploadStatus, setUploadStatus] = useState("");
//   const [loading, setLoading] = useState(false);
//   const [wsStatus, setWsStatus] = useState("Disconnected");
//   const [assetPosition, setAssetPosition] = useState({
//     lat: 40.7825,
//     lng: -73.965,
//   });
//   const [inZone, setInZone] = useState(false);
//   const [eventLog, setEventLog] = useState([]);
//   const [allLogs, setAllLogs] = useState([]);
//   const [currentZone, setCurrentZone] = useState(null);
//   const [assetMoving, setAssetMoving] = useState(true);
//   const [zoneVisibility, setZoneVisibility] = useState({});
//   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
//   const [assetLocation, setAssetLocation] = useState(null);

//   // Clear existing zone overlays from map
//   const clearZoneOverlays = useCallback(() => {
//     zoneOverlaysRef.current.forEach(({ overlay }) => {
//       overlay?.setMap(null);
//     });
//     zoneOverlaysRef.current = [];
//   }, []);

//   // Load Google Maps API
//   useEffect(() => {
//     if (!window.google && !document.getElementById("google-maps-script")) {
//       const script = document.createElement("script");
//       script.id = "google-maps-script";
//       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
//       script.async = true;
//       script.defer = true;
//       script.onload = () => setMapLoaded(true);
//       script.onerror = () => {
//         console.error("Failed to load Google Maps API");
//         toast.error("Failed to load Google Maps API");
//       };
//       document.body.appendChild(script);
//     } else if (window.google) {
//       setMapLoaded(true);
//     }
//   }, []);
//   const handleDrawingComplete = useCallback(async (event) => {
//     let geojson;
//     const name = prompt("Enter Zone Name");

//     if (!name || name.trim() === "") {
//       alert("Zone name cannot be empty.");
//       event.overlay.setMap(null);
//       return;
//     }

//     try {
//       switch (event.type) {
//         case "polygon": {
//           const polygon = event.overlay;
//           const path = polygon.getPath().getArray();
//           if (path.length < 3) {
//             throw new Error("Polygon must have at least 3 points.");
//           }
//           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
//           coordinates.push(coordinates[0]); // Close polygon

//           geojson = {
//             type: "Polygon",
//             coordinates: [coordinates],
//           };
//           break;
//         }

//         case "polyline": {
//           const polyline = event.overlay;
//           const path = polyline.getPath().getArray();
//           if (path.length < 2) {
//             throw new Error("Line must have at least 2 points.");
//           }
//           const coordinates = path.map((latLng) => [
//             latLng.lng(),
//             latLng.lat(),
//           ]);

//           geojson = {
//             type: "LineString",
//             coordinates,
//           };
//           break;
//         }

//         case "circle": {
//           const circle = event.overlay;
//           const center = circle.getCenter();
//           const radius = circle.getRadius();

//           const points = [];
//           const numPoints = 64;
//           for (let i = 0; i < numPoints; i++) {
//             const angle = (i / numPoints) * 2 * Math.PI;
//             const point = turf.destination(
//               turf.point([center.lng(), center.lat()]),
//               radius / 1000,
//               (angle * 180) / Math.PI,
//               { units: "kilometers" }
//             );
//             points.push(point.geometry.coordinates);
//           }
//           points.push(points[0]);

//           geojson = {
//             type: "Polygon",
//             coordinates: [points],
//           };
//           break;
//         }

//         case "rectangle": {
//           const rectangle = event.overlay;
//           const bounds = rectangle.getBounds();
//           const ne = bounds.getNorthEast();
//           const sw = bounds.getSouthWest();
//           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
//           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

//           const coordinates = [
//             [sw.lng(), sw.lat()],
//             [nw.lng(), nw.lat()],
//             [ne.lng(), ne.lat()],
//             [se.lng(), se.lat()],
//             [sw.lng(), sw.lat()],
//           ];

//           geojson = {
//             type: "Polygon",
//             coordinates: [coordinates],
//           };
//           break;
//         }

//         default:
//           throw new Error("Unsupported shape type");
//       }

//       // Validate GeoJSON
//       if (
//         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
//         (geojson.type === "LineString" &&
//           !geojsonValidation.isLineString(geojson))
//       ) {
//         throw new Error("Invalid GeoJSON shape. Please try again.");
//       }

//       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
//       event.overlay.setMap(null);

//       await saveZone(name.trim(), geojson);
//     } catch (error) {
//       console.error("Drawing error:", error);
//       alert(error.message);
//       event.overlay.setMap(null);
//     }
//   }, []);
  

//   const initMap = useCallback(() => {
//     if (!mapRef.current || !window.google || mapInstanceRef.current) return; // ✅ prevent re-init

//     const map = new window.google.maps.Map(mapRef.current, {
//       center: { lat: 40.7829, lng: -73.9654 },
//       zoom: 15,
//       mapTypeControl: true,
//       streetViewControl: true,
//       fullscreenControl: true,
//     });

//     mapInstanceRef.current = map;

//     // ✅ Initialize drawing manager once
//     const drawingManager = new window.google.maps.drawing.DrawingManager({
//       drawingMode: null,
//       drawingControl: true,
//       drawingControlOptions: {
//         position: window.google.maps.ControlPosition.TOP_CENTER,
//         drawingModes: [
//           window.google.maps.drawing.OverlayType.POLYGON,
//           window.google.maps.drawing.OverlayType.POLYLINE,
//           window.google.maps.drawing.OverlayType.CIRCLE,
//           window.google.maps.drawing.OverlayType.RECTANGLE,
//         ],
//       },
//       polygonOptions: {
//         fillColor: "#2196F3",
//         fillOpacity: 0.4,
//         strokeWeight: 2,
//         strokeColor: "#1976D2",
//         clickable: true,
//         editable: false,
//         zIndex: 1,
//       },
//       polylineOptions: {
//         strokeColor: "#2196F3",
//         strokeWeight: 3,
//         clickable: true,
//         editable: false,
//         zIndex: 1,
//       },
//       rectangleOptions: {
//         fillColor: "#2196F3",
//         fillOpacity: 0.4,
//         strokeWeight: 2,
//         strokeColor: "#1976D2",
//         clickable: true,
//         editable: false,
//         zIndex: 1,
//       },
//       circleOptions: {
//         fillColor: "#2196F3",
//         fillOpacity: 0.4,
//         strokeWeight: 2,
//         strokeColor: "#1976D2",
//         clickable: true,
//         editable: false,
//         zIndex: 1,
//       },
//     });

//     drawingManager.setMap(map);

//     // Handle drawing completion
//     window.google.maps.event.addListener(
//       drawingManager,
//       "overlaycomplete",
//       handleDrawingComplete
//     );

//     // ✅ Load zones after initializing map
//     loadZones(); // Don't pass map instance — use ref inside loadZones
//   }, [handleDrawingComplete, loadZones]);

//   // Initialize map when loaded
//   useEffect(() => {
//     if (mapLoaded && mapRef.current && !mapInstanceRef.current) {
//       initMap();
//     }
//   }, [mapLoaded, initMap]);

//   const saveZone = useCallback(async (name, geojson) => {
//     setLoading(true);
//     try {
//       const res = await fetch(apiUrl("/zone"), {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify({ name, geojson }),
//       });

//       if (!res.ok) {
//         const errorData = await res.json().catch(() => ({}));
//         throw new Error(
//           errorData.error || `HTTP ${res.status}: ${res.statusText}`
//         );
//       }

//       const result = await res.json();
//       console.log("Zone saved:", name);

//       // Broadcast zone update via WebSocket
//       // 🔄 Broadcast delete to other users
//       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//         wsRef.current.send(
//           JSON.stringify({
//             action: "default",
//             type: "zone-update",
//             zoneName: name,
//             timestamp: new Date().toISOString(),
//           })
//         );
//       }

//       toast.success("Zone added successfully!");
//       await loadZones(); // Reload zones
//     } catch (err) {
//       console.error("Failed to save zone:", err);
//       toast.error(`Failed to save zone: ${err.message}`);
//     } finally {
//       setLoading(false);
//     }
//   }, []);



//   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
//     const timestamp = new Date().toISOString();

//     const body = {
//       type: eventType,
//       zoneId: zone.id,
//       zoneName: zone.name,
//       geojson: zone.geojson,
//       point: point.geometry.coordinates,
//       timestamp,
//     };

//     try {
//       const res = await fetch(apiUrl("/alert"), {
//         method: "POST",
//         headers: { "Content-Type": "application/json" },
//         body: JSON.stringify(body),
//       });

//       if (!res.ok) {
//         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
//       }

//       console.log("✅ Email alert sent:", body);
//       await logEventToDB(eventType, zone.name, zone.id, timestamp);
//     } catch (err) {
//       console.error("❌ Failed to send email alert:", err);
//       toast.error("Failed to send alert");
//     }
//   }, []);

//   const logEventToDB = useCallback(
//     async (type, zoneName, zoneId, timestamp) => {
//       try {
//         const res = await fetch(apiUrl("/log-event"), {
//           method: "POST",
//           headers: { "Content-Type": "application/json" },
//           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
//         });

//         if (!res.ok) {
//           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
//         }

//         console.log("✅ Log saved to DB");
//       } catch (err) {
//         console.error("❌ Failed to save log to DB:", err);
//       }
//     },
//     []
//   );

//   const handleDelete = async (zoneId) => {
//     try {
//       setLoading(true);

//       // ✅ Delete request
//       const response = await fetch(apiUrl(`/zone/${zoneId}`), {
//         method: "DELETE",
//       });

//       if (!response.ok) {
//         throw new Error("Failed to delete zone");
//       }

//       // ✅ Remove from map
//       const remainingOverlays = zoneOverlaysRef.current.filter((z) => {
//         if (z.id === zoneId) {
//           z.overlay.setMap(null);
//           return false;
//         }
//         return true;
//       });
//       zoneOverlaysRef.current = remainingOverlays;

//       // ✅ Remove from UI
//       setZones((prev) => prev.filter((z) => z.id !== zoneId));
//       setZoneVisibility((prev) => {
//         const newState = { ...prev };
//         delete newState[zoneId];
//         return newState;
//       });

//       // ✅ Broadcast WebSocket message
//       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
//         wsRef.current.send(
//           JSON.stringify({
//             action: "default",
//             type: "zone-delete",
//             zoneId, // ✅ correct variable
//           })
//         );
//       }

//       console.log("✅ Deleted zone:", zoneId);
//     } catch (err) {
//       console.error("❌ Delete failed", err);
//     } finally {
//       setLoading(false);
//     }
//   };

//   const handleFileUpload = useCallback(
//     async (event) => {
//       const files = event.target.files;
//       if (!files || files.length === 0) return;

//       setLoading(true);
//       let successCount = 0;
//       let errorCount = 0;

//       for (let file of files) {
//         try {
//           const text = await file.text();
//           const json = JSON.parse(text);

//           if (
//             !geojsonValidation.isPolygon(json) &&
//             !geojsonValidation.isMultiPolygon(json) &&
//             !geojsonValidation.isLineString(json)
//           ) {
//             throw new Error(
//               "Only Polygon, MultiPolygon, or LineString supported"
//             );
//           }

//           const name =
//             prompt(`Enter a name for zone in ${file.name}`) ||
//             file.name.replace(".geojson", "");

//           if (!name || name.trim() === "") {
//             throw new Error("Zone name is required");
//           }

//           await saveZone(name.trim(), json);
//           successCount++;
//         } catch (err) {
//           console.error(`Error processing ${file.name}:`, err);
//           errorCount++;
//           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
//         }
//       }

//       if (successCount > 0) {
//         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
//       }
//       if (errorCount > 0) {
//         toast.error(`Failed to upload ${errorCount} files`);
//       }

//       if (fileInputRef.current) {
//         fileInputRef.current.value = "";
//       }

//       setLoading(false);
//     },
//     [saveZone]
//   );

//   const fetchAllLogs = useCallback(async () => {
//     try {
//       const res = await fetch(apiUrl("/logs"));
//       if (!res.ok) {
//         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
//       }

//       const data = await res.json();
//       setAllLogs(
//         data.sort(
//           (a, b) =>
//             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
//         )
//       );
//     } catch (err) {
//       console.error("Failed to fetch logs:", err);
//       toast.error("Failed to fetch logs");
//     }
//   }, []);

//   const toggleZoneVisibility = useCallback((zoneId) => {
//     setZoneVisibility((prev) => {
//       const newVisibility = !prev[zoneId];

//       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
//       if (overlayObj && overlayObj.overlay) {
//         overlayObj.overlay.setMap(
//           newVisibility ? mapInstanceRef.current : null
//         );
//       }

//       return {
//         ...prev,
//         [zoneId]: newVisibility,
//       };
//     });
//   }, []);

//   // Asset movement and geofencing logic
//   // Asset movement and geofencing logic
//   // Disable fake asset movement – now use only WebSocket-driven updates
//   useEffect(() => {
//     if (
//       !mapLoaded ||
//       !zones.length ||
//       !mapInstanceRef.current ||
//       !assetLocation
//     )
//       return;

//     const newPos = {
//       lat: assetLocation.lat,
//       lng: assetLocation.lng,
//     };

//     const point = turf.point([newPos.lng, newPos.lat]);
//     let matchedZone = null;

//     for (let zone of zones) {
//       if (zone.geojson.type === "Polygon") {
//         try {
//           const polygon = turf.polygon(zone.geojson.coordinates);
//           if (turf.booleanPointInPolygon(point, polygon)) {
//             matchedZone = zone;
//             break;
//           }
//         } catch (error) {
//           console.warn("Error checking zone intersection:", error);
//         }
//       }
//     }

//     const inside = Boolean(matchedZone);
//     const wasInside = Boolean(lastZoneRef.current);
//     const ts = new Date().toISOString();

//     if (inside && !wasInside) {
//       lastZoneRef.current = matchedZone;
//       zoneEntryTimeRef.current = ts;
//       setInZone(true);
//       setCurrentZone(matchedZone);
//       setEventLog((prev) => [
//         { type: "Entered", zone: matchedZone.name, time: ts },
//         ...prev.slice(0, 9),
//       ]);
//       toast.success(`🚧 Entered zone ${matchedZone.name}`);
//       sendEmailAlert("ENTER", matchedZone, point);
//       fetchAllLogs();
//     } else if (!inside && wasInside) {
//       const exitedZone = lastZoneRef.current;
//       lastZoneRef.current = null;
//       setInZone(false);
//       setCurrentZone(null);

//       const entryTime = new Date(zoneEntryTimeRef.current).getTime();
//       const exitTime = new Date(ts).getTime();
//       const durationMs = exitTime - entryTime;

//       const minutes = Math.floor(durationMs / 60000);
//       const seconds = Math.floor((durationMs % 60000) / 1000);
//       const durationStr = `${minutes}m ${seconds}s`;

//       setEventLog((prev) => [
//         {
//           type: `Exited`,
//           zone: exitedZone?.name || "Unknown",
//           time: ts,
//           duration: `Stayed for ${durationStr}`,
//         },
//         ...prev.slice(0, 9),
//       ]);
//       toast.success(
//         `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
//       );
//       sendEmailAlert("EXIT", exitedZone || {}, point);
//       fetchAllLogs();
//     }

//     if (!markerRef.current && mapInstanceRef.current) {
//       markerRef.current = new window.google.maps.Marker({
//         map: mapInstanceRef.current,
//         title: "Live Asset Location",
//         icon: {
//           url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
//           scaledSize: new window.google.maps.Size(40, 40),
//         },
//       });
//     }

//     if (markerRef.current) {
//       markerRef.current.setIcon({
//         url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
//         scaledSize: new window.google.maps.Size(40, 40),
//       });

//       markerRef.current.setPosition(
//         new window.google.maps.LatLng(newPos.lat, newPos.lng)
//       );
//     }
//   }, [mapLoaded, assetLocation, zones, sendEmailAlert, fetchAllLogs]);

//   // WebSocket connection management
//   useEffect(() => {
//     const connectWebSocket = () => {
//       const socket = new WebSocket(
//         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
//       );

//       wsRef.current = socket;

//       socket.onopen = () => {
//         console.log("✅ WebSocket connected");
//         setWsStatus("Connected");
//       };

//       socket.onclose = () => {
//         console.warn("🔌 WebSocket disconnected. Reconnecting...");
//         setWsStatus("Disconnected");
//         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
//       };

//       socket.onerror = (err) => {
//         console.error("❌ WebSocket error", err);
//         socket.close();
//       };

//       socket.onmessage = (event) => {
//         try {
//           const data = JSON.parse(event.data);
//           console.log("📨 WebSocket message received:", data);

//           // ✅ Log raw lat/lng if present
//           if (data.lat && data.lng) {
//             console.log("🛰️ Incoming Location Data →", {
//               lat: data.lat,
//               lng: data.lng,
//               type: data.type,
//             });
//           }

//           // ✅ Match by type
//           if (data.type === "assetLocationUpdate") {
//             const { lat, lng } = data.data;

//             console.log("📍 Updating marker position to →", lat, lng);

//             setAssetLocation({ lat, lng });

//             if (!markerRef.current && mapInstanceRef.current) {
//               console.log("🆕 Creating marker for live asset");
//               markerRef.current = new window.google.maps.Marker({
//                 map: mapInstanceRef.current,
//                 title: "Live Asset Location",
//                 icon: {
//                   url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
//                   scaledSize: new window.google.maps.Size(32, 32),
//                 },
//               });
//             }

//             if (markerRef.current) {
//               markerRef.current.setPosition(
//                 new window.google.maps.LatLng(lat, lng)
//               );
//               // mapInstanceRef.current.setCenter({ lat, lng });
//             } else {
//               console.warn("❌ Marker is still null");
//             }
//           } else {
//             console.warn("🟡 Unhandled message type or missing `type`:", data);
//           }
//         } catch (err) {
//           console.error("❌ Failed to parse WebSocket message:", err);
//         }
//       };
//     };

//     connectWebSocket();

//     return () => {
//       if (wsRef.current) {
//         wsRef.current.close();
//       }
//       if (reconnectTimeoutRef.current) {
//         clearTimeout(reconnectTimeoutRef.current);
//       }
//     };
//   }, [loadZones]);

//   // Load logs on component mount
//   useEffect(() => {
//     fetchAllLogs();
//   }, [fetchAllLogs]);

//   // Cleanup on unmount
//   useEffect(() => {
//     return () => {
//       clearZoneOverlays();
//       if (assetMovementIntervalRef.current) {
//         clearInterval(assetMovementIntervalRef.current);
//       }
//     };
//   }, [clearZoneOverlays]);

//   const toggleAssetMovement = useCallback(() => {
//     setAssetMoving((prev) => !prev);
//   }, []);

//   const refreshZones = useCallback(() => {
//     loadZones();
//   }, [loadZones]);

//   return (
//     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
//       <Typography variant="h4" gutterBottom>
//         🗺️ Zone Manager
//       </Typography>

//       {/* Status indicators */}
//       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
//         <Chip
//           label={`WebSocket: ${wsStatus}`}
//           color={wsStatus === "Connected" ? "success" : "error"}
//           variant="outlined"
//           size="small"
//         />
//         <Chip
//           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
//           color={assetMoving ? "primary" : "default"}
//           variant="outlined"
//           size="small"
//         />
//         {currentZone && (
//           <Chip
//             label={`In Zone: ${currentZone.name}`}
//             color="success"
//             variant="filled"
//             size="small"
//           />
//         )}
//       </Box>

//       {/* Loading indicator */}
//       {loading && <LinearProgress sx={{ mb: 2 }} />}

//       {/* Map container */}
//       <Box
//         ref={mapRef}
//         sx={{
//           width: "100%",
//           height: "500px",
//           mb: 3,
//           border: 1,
//           borderColor: "grey.300",
//           borderRadius: 1,
//         }}
//       />

//       {/* Asset controls */}
//       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
//         <Button
//           variant="outlined"
//           onClick={toggleAssetMovement}
//           color={assetMoving ? "error" : "success"}
//         >
//           {assetMoving ? "Stop Asset" : "Start Asset"}
//         </Button>
//         <Button
//           variant="outlined"
//           onClick={refreshZones}
//           startIcon={<RefreshIcon />}
//         >
//           Refresh Zones
//         </Button>
//       </Box>

//       {/* File upload section */}
//       <Card sx={{ mb: 3 }}>
//         <CardContent>
//           <Typography variant="h6" gutterBottom>
//             📂 Upload GeoJSON Zone
//           </Typography>
//           <input
//             type="file"
//             ref={fileInputRef}
//             accept=".geojson,application/geo+json"
//             onChange={handleFileUpload}
//             multiple
//             disabled={loading}
//             style={{ marginBottom: "16px" }}
//           />
//           {uploadStatus && (
//             <Alert
//               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
//               sx={{ mt: 1 }}
//             >
//               {uploadStatus}
//             </Alert>
//           )}
//         </CardContent>
//       </Card>

//       <Divider sx={{ my: 3 }} />

//       {/* Zones list */}
//       <Card sx={{ mb: 3 }}>
//         <CardContent>
//           <Typography variant="h6" gutterBottom>
//             🗂️ Saved Zones ({zones.length})
//           </Typography>

//           {zones.length === 0 ? (
//             <Typography color="text.secondary">
//               No zones available. Draw zones on the map or upload GeoJSON files.
//             </Typography>
//           ) : (
//             <Grid container spacing={2}>
//               {zones.map((zone) => (
//                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
//                   <Card variant="outlined">
//                     <CardContent
//                       sx={{
//                         display: "flex",
//                         justifyContent: "space-between",
//                         alignItems: "center",
//                       }}
//                     >
//                       <Box>
//                         <Typography variant="subtitle1" gutterBottom>
//                           {zone.name}
//                         </Typography>
//                         <Typography variant="body2" color="text.secondary">
//                           Type: {zone.geojson.type}
//                         </Typography>
//                         {zone.created_at && (
//                           <Typography variant="caption" color="text.secondary">
//                             Created:{" "}
//                             {new Date(zone.created_at).toLocaleDateString()}
//                           </Typography>
//                         )}
//                       </Box>
//                       <Box>
//                         <label>
//                           <input
//                             type="checkbox"
//                             checked={zoneVisibility[zone.id] ?? true}
//                             onChange={() => toggleZoneVisibility(zone.id)}
//                           />{" "}
//                           Visible
//                         </label>
//                       </Box>
//                     </CardContent>

//                     <CardActions>
//                       <Tooltip title="Delete zone">
//                         <IconButton
//                           color="error"
//                           onClick={() => handleDelete(zone.id)}
//                           disabled={loading}
//                         >
//                           <DeleteIcon />
//                         </IconButton>
//                       </Tooltip>
//                     </CardActions>
//                   </Card>
//                 </Grid>
//               ))}
//             </Grid>
//           )}
//         </CardContent>
//       </Card>

//       <Divider sx={{ my: 3 }} />

//       {/* Event log */}
//       <Grid container spacing={3}>
//         <Grid item xs={12} md={6}>
//           <Card>
//             <CardContent>
//               <Typography variant="h6" gutterBottom>
//                 📋 Recent Events
//               </Typography>
//               {eventLog.length === 0 ? (
//                 <Typography color="text.secondary">
//                   No recent events.
//                 </Typography>
//               ) : (
//                 <List dense>
//                   {eventLog.map((event, idx) => (
//                     <ListItem key={idx}>
//                       <ListItemText
//                         primary={`${event.type} - ${event.zone}`}
//                         secondary={new Date(event.time).toLocaleString()}
//                       />
//                     </ListItem>
//                   ))}
//                 </List>
//               )}
//             </CardContent>
//           </Card>
//         </Grid>

//         <Grid item xs={12} md={6}>
//           <Card>
//             <CardContent>
//               <Typography variant="h6" gutterBottom>
//                 📜 Full Log History
//               </Typography>

//               {/* Zone Filter Dropdown */}
//               <Box sx={{ mb: 2 }}>
//                 <Typography variant="body2" sx={{ mb: 1 }}>
//                   Filter Logs by Zone:
//                 </Typography>
//                 <Select
//                   size="small"
//                   value={selectedZoneFilter}
//                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
//                   displayEmpty
//                   sx={{ minWidth: 200 }}
//                 >
//                   <MenuItem value="All">All</MenuItem>
//                   {zones.map((zone) => (
//                     <MenuItem key={zone.id} value={zone.name}>
//                       {zone.name}
//                     </MenuItem>
//                   ))}
//                 </Select>
//               </Box>

//               {/* Filtered Logs List */}
//               {allLogs.length === 0 ? (
//                 <Typography color="text.secondary">No logs found.</Typography>
//               ) : (
//                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
//                   {allLogs
//                     .filter(
//                       (log) =>
//                         selectedZoneFilter === "All" ||
//                         log.zoneName === selectedZoneFilter
//                     )
//                     .slice(0, 50)
//                     .map((log, idx) => (
//                       <ListItem key={log.id || idx}>
//                         <ListItemText
//                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
//                           secondary={new Date(log.timestamp).toLocaleString()}
//                         />
//                       </ListItem>
//                     ))}
//                 </List>
//               )}
//             </CardContent>
//           </Card>
//         </Grid>
//       </Grid>

//       {/* Asset position debug info */}
//       <Box sx={{ mt: 3 }}>
//         <Typography variant="caption" color="text.secondary">
//           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
//           {assetPosition.lng.toFixed(6)}
//           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
//         </Typography>
//       </Box>
//     </Box>
//   );
// };

// export default ZoneManager;

// // import React, { useEffect, useRef, useState, useCallback } from "react";
// // import {
// //   Box,
// //   Typography,
// //   Button,
// //   Divider,
// //   List,
// //   ListItem,
// //   ListItemText,
// //   Alert,
// //   LinearProgress,
// //   Chip,
// //   Card,
// //   CardContent,
// //   CardActions,
// //   Grid,
// //   IconButton,
// //   Tooltip,
// //   Select,
// //   MenuItem,
// // } from "@mui/material";
// // import DeleteIcon from "@mui/icons-material/Delete";
// // import RefreshIcon from "@mui/icons-material/Refresh";
// // import * as turf from "@turf/turf";
// // import * as geojsonValidation from "geojson-validation";
// // import { z } from "zod";
// // import toast from "react-hot-toast";

// // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // const WS_API_ENDPOINT =
// //   process.env.REACT_APP_WS_URL ||
// //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // function apiUrl(path) {
// //   return `${API_BASE_URL}${path}`;
// // }

// // // Enhanced validation schemas
// // const LatLngSchema = z.object({
// //   lat: z.number().min(-90).max(90),
// //   lng: z.number().min(-180).max(180),
// // });

// // const ZoneSchema = z.object({
// //   id: z.string(),
// //   name: z.string().min(1),
// //   geojson: z.object({
// //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// //     coordinates: z.array(z.any()),
// //   }),
// //   created_at: z.string().optional(),
// // });

// // const ZoneManager = () => {
// //   const mapRef = useRef(null);
// //   const markerRef = useRef(null);
// //   const mapInstanceRef = useRef(null);
// //   const fileInputRef = useRef(null);
// //   const zoneOverlaysRef = useRef([]);
// //   const lastZoneRef = useRef(null);
// //   const wsRef = useRef(null);
// //   const reconnectTimeoutRef = useRef(null);
// //   const assetMovementIntervalRef = useRef(null);
// //   const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

// //   // State management
// //   const [mapLoaded, setMapLoaded] = useState(false);
// //   const [zones, setZones] = useState([]);
// //   const [uploadStatus, setUploadStatus] = useState("");
// //   const [loading, setLoading] = useState(false);
// //   const [wsStatus, setWsStatus] = useState("Disconnected");
// //   const [assetPosition, setAssetPosition] = useState({
// //     lat: 40.7825,
// //     lng: -73.965,
// //   });
// //   const [inZone, setInZone] = useState(false);
// //   const [eventLog, setEventLog] = useState([]);
// //   const [allLogs, setAllLogs] = useState([]);
// //   const [currentZone, setCurrentZone] = useState(null);
// //   const [assetMoving, setAssetMoving] = useState(true);
// //   const [zoneVisibility, setZoneVisibility] = useState({});
// //   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
// //   const [zoneEntryTime, setZoneEntryTime] = useState(null); // ⏱️ Zone entry timestamp

// //   // Clear existing zone overlays from map
// //   const clearZoneOverlays = useCallback(() => {
// //     zoneOverlaysRef.current.forEach(({ overlay }) => {
// //       overlay?.setMap(null);
// //     });
// //     zoneOverlaysRef.current = [];
// //   }, []);

// //   // Load Google Maps API
// //   useEffect(() => {
// //     if (!window.google && !document.getElementById("google-maps-script")) {
// //       const script = document.createElement("script");
// //       script.id = "google-maps-script";
// //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// //       script.async = true;
// //       script.defer = true;
// //       script.onload = () => setMapLoaded(true);
// //       script.onerror = () => {
// //         console.error("Failed to load Google Maps API");
// //         toast.error("Failed to load Google Maps API");
// //       };
// //       document.body.appendChild(script);
// //     } else if (window.google) {
// //       setMapLoaded(true);
// //     }
// //   }, []);

// //   // Initialize map when loaded
// //   useEffect(() => {
// //     if (mapLoaded && mapRef.current) {
// //       initMap();
// //     }
// //   }, [mapLoaded]);

// //   const initMap = useCallback(() => {
// //     if (!mapRef.current || !window.google) return;

// //     const map = new window.google.maps.Map(mapRef.current, {
// //       center: { lat: 40.7829, lng: -73.9654 },
// //       zoom: 15,
// //       mapTypeControl: true,
// //       streetViewControl: true,
// //       fullscreenControl: true,
// //     });
// //     mapInstanceRef.current = map;

// //     // Initialize drawing manager
// //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// //       drawingMode: null,
// //       drawingControl: true,
// //       drawingControlOptions: {
// //         position: window.google.maps.ControlPosition.TOP_CENTER,
// //         drawingModes: [
// //           window.google.maps.drawing.OverlayType.POLYGON,
// //           window.google.maps.drawing.OverlayType.POLYLINE,
// //           window.google.maps.drawing.OverlayType.CIRCLE,
// //           window.google.maps.drawing.OverlayType.RECTANGLE,
// //         ],
// //       },
// //       polygonOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       polylineOptions: {
// //         strokeColor: "#2196F3",
// //         strokeWeight: 3,
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       rectangleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       circleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //     });

// //     drawingManager.setMap(map);

// //     // Handle drawing completion
// //     window.google.maps.event.addListener(
// //       drawingManager,
// //       "overlaycomplete",
// //       handleDrawingComplete
// //     );

// //     // Load existing zones
// //     loadZones(map);
// //   }, []);

// //   const handleDrawingComplete = useCallback(async (event) => {
// //     let geojson;
// //     const name = prompt("Enter Zone Name");

// //     if (!name || name.trim() === "") {
// //       alert("Zone name cannot be empty.");
// //       event.overlay.setMap(null);
// //       return;
// //     }

// //     try {
// //       switch (event.type) {
// //         case "polygon": {
// //           const polygon = event.overlay;
// //           const path = polygon.getPath().getArray();
// //           if (path.length < 3) {
// //             throw new Error("Polygon must have at least 3 points.");
// //           }
// //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// //           coordinates.push(coordinates[0]); // Close polygon

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         case "polyline": {
// //           const polyline = event.overlay;
// //           const path = polyline.getPath().getArray();
// //           if (path.length < 2) {
// //             throw new Error("Line must have at least 2 points.");
// //           }
// //           const coordinates = path.map((latLng) => [
// //             latLng.lng(),
// //             latLng.lat(),
// //           ]);

// //           geojson = {
// //             type: "LineString",
// //             coordinates,
// //           };
// //           break;
// //         }

// //         case "circle": {
// //           const circle = event.overlay;
// //           const center = circle.getCenter();
// //           const radius = circle.getRadius();

// //           const points = [];
// //           const numPoints = 64;
// //           for (let i = 0; i < numPoints; i++) {
// //             const angle = (i / numPoints) * 2 * Math.PI;
// //             const point = turf.destination(
// //               turf.point([center.lng(), center.lat()]),
// //               radius / 1000,
// //               (angle * 180) / Math.PI,
// //               { units: "kilometers" }
// //             );
// //             points.push(point.geometry.coordinates);
// //           }
// //           points.push(points[0]);

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [points],
// //           };
// //           break;
// //         }

// //         case "rectangle": {
// //           const rectangle = event.overlay;
// //           const bounds = rectangle.getBounds();
// //           const ne = bounds.getNorthEast();
// //           const sw = bounds.getSouthWest();
// //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// //           const coordinates = [
// //             [sw.lng(), sw.lat()],
// //             [nw.lng(), nw.lat()],
// //             [ne.lng(), ne.lat()],
// //             [se.lng(), se.lat()],
// //             [sw.lng(), sw.lat()],
// //           ];

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         default:
// //           throw new Error("Unsupported shape type");
// //       }

// //       // Validate GeoJSON
// //       if (
// //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// //         (geojson.type === "LineString" &&
// //           !geojsonValidation.isLineString(geojson))
// //       ) {
// //         throw new Error("Invalid GeoJSON shape. Please try again.");
// //       }

// //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// //       event.overlay.setMap(null);

// //       await saveZone(name.trim(), geojson);
// //     } catch (error) {
// //       console.error("Drawing error:", error);
// //       alert(error.message);
// //       event.overlay.setMap(null);
// //     }
// //   }, []);

// //   const saveZone = useCallback(async (name, geojson) => {
// //     setLoading(true);
// //     try {
// //       const res = await fetch(apiUrl("/zone"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify({ name, geojson }),
// //       });

// //       if (!res.ok) {
// //         const errorData = await res.json().catch(() => ({}));
// //         throw new Error(
// //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// //         );
// //       }

// //       const result = await res.json();
// //       console.log("Zone saved:", name);

// //       // Broadcast zone update via WebSocket
// //       // 🔄 Broadcast delete to other users
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         wsRef.current.send(
// //           JSON.stringify({
// //             action: "default",
// //             type: "zone-update",
// //             zoneName: name,
// //             timestamp: new Date().toISOString(),
// //           })
// //         );
// //       }

// //       toast.success("Zone added successfully!");
// //       await loadZones(); // Reload zones
// //     } catch (err) {
// //       console.error("Failed to save zone:", err);
// //       toast.error(`Failed to save zone: ${err.message}`);
// //     } finally {
// //       setLoading(false);
// //     }
// //   }, []);

// //   const loadZones = useCallback(
// //     async (mapInstance) => {
// //       try {
// //         const res = await fetch(apiUrl("/zones"));
// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         const data = await res.json();

// //         // Validate zones data
// //         const validatedZones = data.filter((zone) => {
// //           try {
// //             ZoneSchema.parse(zone);
// //             return true;
// //           } catch (error) {
// //             console.warn("Invalid zone data:", zone, error);
// //             return false;
// //           }
// //         });

// //         setZones(validatedZones);

// //         const map = mapInstance || mapInstanceRef.current;
// //         if (!map) return;

// //         // Clear existing zone overlays before adding new ones
// //         clearZoneOverlays();

// //         // Add new zone overlays
// //         validatedZones.forEach((zone) => {
// //           let overlay;

// //           if (zone.geojson.type === "Polygon") {
// //             overlay = new window.google.maps.Polygon({
// //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 2,
// //               fillColor: "#FF0000",
// //               fillOpacity: 0.2,
// //             });
// //           } else if (zone.geojson.type === "LineString") {
// //             overlay = new window.google.maps.Polyline({
// //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 3,
// //             });
// //           }

// //           if (overlay) {
// //             overlay.setMap(map); // Show on map initially

// //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// //             // ✅ Track visibility status
// //             setZoneVisibility((prev) => ({
// //               ...prev,
// //               [zone.id]: true,
// //             }));

// //             // Add click listener for zone info
// //             overlay.addListener("click", () => {
// //               const infoWindow = new window.google.maps.InfoWindow({
// //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// //               });

// //               const position =
// //                 overlay.getPath?.().getAt(0) ??
// //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// //               if (position) {
// //                 infoWindow.setPosition(position);
// //                 infoWindow.open(map);
// //               }
// //             });
// //           }
// //         });
// //       } catch (err) {
// //         console.error("Failed to load zones:", err);
// //         toast.error("Failed to load zones");
// //       }
// //     },
// //     [clearZoneOverlays]
// //   );

// //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// //     const timestamp = new Date().toISOString();

// //     const body = {
// //       type: eventType,
// //       zoneId: zone.id,
// //       zoneName: zone.name,
// //       geojson: zone.geojson,
// //       point: point.geometry.coordinates,
// //       timestamp,
// //     };

// //     try {
// //       const res = await fetch(apiUrl("/alert"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify(body),
// //       });

// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       console.log("✅ Email alert sent:", body);
// //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// //     } catch (err) {
// //       console.error("❌ Failed to send email alert:", err);
// //       toast.error("Failed to send alert");
// //     }
// //   }, []);

// //   const logEventToDB = useCallback(
// //     async (type, zoneName, zoneId, timestamp) => {
// //       try {
// //         const res = await fetch(apiUrl("/log-event"), {
// //           method: "POST",
// //           headers: { "Content-Type": "application/json" },
// //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// //         });

// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         console.log("✅ Log saved to DB");
// //       } catch (err) {
// //         console.error("❌ Failed to save log to DB:", err);
// //       }
// //     },
// //     []
// //   );

// //   const handleDelete = async (zoneId) => {
// //     try {
// //       setLoading(true);

// //       // ✅ Delete request
// //       const response = await fetch(apiUrl(`/zone/${zoneId}`), {
// //         method: "DELETE",
// //       });

// //       if (!response.ok) {
// //         throw new Error("Failed to delete zone");
// //       }

// //       // ✅ Remove from map
// //       const remainingOverlays = zoneOverlaysRef.current.filter((z) => {
// //         if (z.id === zoneId) {
// //           z.overlay.setMap(null);
// //           return false;
// //         }
// //         return true;
// //       });
// //       zoneOverlaysRef.current = remainingOverlays;

// //       // ✅ Remove from UI
// //       setZones((prev) => prev.filter((z) => z.id !== zoneId));
// //       setZoneVisibility((prev) => {
// //         const newState = { ...prev };
// //         delete newState[zoneId];
// //         return newState;
// //       });

// //       // ✅ Broadcast WebSocket message
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         wsRef.current.send(
// //           JSON.stringify({
// //             action: "default",
// //             type: "zone-delete",
// //             zoneId, // ✅ correct variable
// //           })
// //         );
// //       }

// //       console.log("✅ Deleted zone:", zoneId);
// //     } catch (err) {
// //       console.error("❌ Delete failed", err);
// //     } finally {
// //       setLoading(false);
// //     }
// //   };

// //   const handleFileUpload = useCallback(
// //     async (event) => {
// //       const files = event.target.files;
// //       if (!files || files.length === 0) return;

// //       setLoading(true);
// //       let successCount = 0;
// //       let errorCount = 0;

// //       for (let file of files) {
// //         try {
// //           const text = await file.text();
// //           const json = JSON.parse(text);

// //           if (
// //             !geojsonValidation.isPolygon(json) &&
// //             !geojsonValidation.isMultiPolygon(json) &&
// //             !geojsonValidation.isLineString(json)
// //           ) {
// //             throw new Error(
// //               "Only Polygon, MultiPolygon, or LineString supported"
// //             );
// //           }

// //           const name =
// //             prompt(`Enter a name for zone in ${file.name}`) ||
// //             file.name.replace(".geojson", "");

// //           if (!name || name.trim() === "") {
// //             throw new Error("Zone name is required");
// //           }

// //           await saveZone(name.trim(), json);
// //           successCount++;
// //         } catch (err) {
// //           console.error(`Error processing ${file.name}:`, err);
// //           errorCount++;
// //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// //         }
// //       }

// //       if (successCount > 0) {
// //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// //       }
// //       if (errorCount > 0) {
// //         toast.error(`Failed to upload ${errorCount} files`);
// //       }

// //       if (fileInputRef.current) {
// //         fileInputRef.current.value = "";
// //       }

// //       setLoading(false);
// //     },
// //     [saveZone]
// //   );

// //   const fetchAllLogs = useCallback(async () => {
// //     try {
// //       const res = await fetch(apiUrl("/logs"));
// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       const data = await res.json();
// //       setAllLogs(
// //         data.sort(
// //           (a, b) =>
// //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// //         )
// //       );
// //     } catch (err) {
// //       console.error("Failed to fetch logs:", err);
// //       toast.error("Failed to fetch logs");
// //     }
// //   }, []);

// //   const toggleZoneVisibility = useCallback((zoneId) => {
// //     setZoneVisibility((prev) => {
// //       const newVisibility = !prev[zoneId];

// //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// //       if (overlayObj && overlayObj.overlay) {
// //         overlayObj.overlay.setMap(
// //           newVisibility ? mapInstanceRef.current : null
// //         );
// //       }

// //       return {
// //         ...prev,
// //         [zoneId]: newVisibility,
// //       };
// //     });
// //   }, []);

// //   // Asset movement and geofencing logic
// //   // Asset movement and geofencing logic
// //   useEffect(() => {
// //     if (
// //       !mapLoaded ||
// //       zones.length === 0 ||
// //       !mapInstanceRef.current ||
// //       !assetMoving
// //     )
// //       return;

// //     const interval = setInterval(() => {
// //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// //       setAssetPosition((prev) => {
// //         const newPos = {
// //           lat: prev.lat + deltaLat,
// //           lng: prev.lng + deltaLng,
// //         };

// //         try {
// //           LatLngSchema.parse(newPos);
// //         } catch (err) {
// //           console.warn("Invalid coordinates, skipping...");
// //           return prev;
// //         }

// //         const point = turf.point([newPos.lng, newPos.lat]);
// //         let matchedZone = null;

// //         for (let zone of zones) {
// //           if (zone.geojson.type === "Polygon") {
// //             try {
// //               const polygon = turf.polygon(zone.geojson.coordinates);
// //               if (turf.booleanPointInPolygon(point, polygon)) {
// //                 matchedZone = zone;
// //                 break;
// //               }
// //             } catch (error) {
// //               console.warn("Error checking zone intersection:", error);
// //             }
// //           }
// //         }

// //         const inside = Boolean(matchedZone);
// //         const wasInside = Boolean(lastZoneRef.current);

// //         const ts = new Date().toISOString();

// //         if (inside && !wasInside) {
// //           lastZoneRef.current = matchedZone;
// //           zoneEntryTimeRef.current = ts;
// //           setInZone(true);
// //           setCurrentZone(matchedZone);

// //           setEventLog((prev) => [
// //             { type: "Entered", zone: matchedZone.name, time: ts },
// //             ...prev.slice(0, 9),
// //           ]);

// //           toast.success(`🚧 Entered zone ${matchedZone.name}`);
// //           sendEmailAlert("ENTER", matchedZone, point);
// //           fetchAllLogs();
// //         } else if (!inside && wasInside) {
// //           const exitedZone = lastZoneRef.current;
// //           lastZoneRef.current = null;
// //           setInZone(false);
// //           setCurrentZone(null);

// //           const entryTime = new Date(zoneEntryTimeRef.current).getTime();
// //           const exitTime = new Date(ts).getTime();
// //           const durationMs = exitTime - entryTime;

// //           const minutes = Math.floor(durationMs / 60000);
// //           const seconds = Math.floor((durationMs % 60000) / 1000);
// //           const durationStr = `${minutes}m ${seconds}s`;

// //           setEventLog((prev) => [
// //             {
// //               type: `Exited`,
// //               zone: exitedZone?.name || "Unknown",
// //               time: ts,
// //               duration: `Stayed for ${durationStr}`,
// //             },
// //             ...prev.slice(0, 9),
// //           ]);

// //           toast.success(
// //             `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
// //           );
// //           sendEmailAlert("EXIT", exitedZone || {}, point);
// //           fetchAllLogs();
// //         }

// //         const map = mapInstanceRef.current;
// //         if (!markerRef.current && map) {
// //           markerRef.current = new window.google.maps.Marker({
// //             map,
// //             title: "Asset Tracker",
// //             icon: {
// //               path: window.google.maps.SymbolPath.CIRCLE,
// //               scale: 8,
// //               fillColor: matchedZone ? "#4CAF50" : "#F44336",
// //               fillOpacity: 1,
// //               strokeWeight: 2,
// //               strokeColor: "#FFFFFF",
// //             },
// //           });
// //         }

// //         if (markerRef.current) {
// //           markerRef.current.setIcon({
// //             path: window.google.maps.SymbolPath.CIRCLE,
// //             scale: 8,
// //             fillColor: matchedZone ? "#4CAF50" : "#F44336",
// //             fillOpacity: 1,
// //             strokeWeight: 2,
// //             strokeColor: "#FFFFFF",
// //           });

// //           markerRef.current.setPosition(
// //             new window.google.maps.LatLng(newPos.lat, newPos.lng)
// //           );
// //         }

// //         return newPos;
// //       });
// //     }, 1000);

// //     assetMovementIntervalRef.current = interval;
// //     return () => clearInterval(interval);
// //   }, [zones, mapLoaded, assetMoving, sendEmailAlert, fetchAllLogs]);

// //   // WebSocket connection management
// //   useEffect(() => {
// //     const connectWebSocket = () => {
// //       const socket = new WebSocket(
// //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// //       );

// //       wsRef.current = socket;

// //       socket.onopen = () => {
// //         console.log("✅ WebSocket connected");
// //         setWsStatus("Connected");
// //       };

// //       socket.onclose = () => {
// //         console.warn("🔌 WebSocket disconnected. Reconnecting...");
// //         setWsStatus("Disconnected");
// //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
// //       };

// //       socket.onerror = (err) => {
// //         console.error("❌ WebSocket error", err);
// //         socket.close();
// //       };

// //       socket.onmessage = (event) => {
// //         try {
// //           const data = JSON.parse(event.data);
// //           console.log("📨 WebSocket message received:", data);

// //           // 🔁 Real-time zone update (e.g., add or edit)
// //           if (data.type === "zone-update") {
// //             console.log("🔄 Reloading zones due to update...");
// //             loadZones();
// //           }

// //           // 🗑️ Real-time zone delete
// //           else if (data.type === "zone-delete") {
// //             const deletedZoneId = data.zoneId;
// //             console.log("🗑️ Zone deleted in real time:", deletedZoneId);

// //             // ✅ Remove from zones UI
// //             setZones((prev) => prev.filter((z) => z.id !== deletedZoneId));

// //             // ✅ FIXED: More robust overlay removal
// //             const overlayToRemove = zoneOverlaysRef.current.find(
// //               (z) => z.id === deletedZoneId
// //             );
// //             if (overlayToRemove && overlayToRemove.overlay) {
// //               overlayToRemove.overlay.setMap(null);
// //               console.log(
// //                 "✅ Removed overlay from map for zone:",
// //                 deletedZoneId
// //               );
// //             } else {
// //               console.warn(
// //                 "❌ Could not find overlay for zone:",
// //                 deletedZoneId
// //               );
// //             }

// //             // ✅ Update the overlays array
// //             zoneOverlaysRef.current = zoneOverlaysRef.current.filter(
// //               (z) => z.id !== deletedZoneId
// //             );

// //             // ✅ Remove visibility toggle
// //             setZoneVisibility((prev) => {
// //               const copy = { ...prev };
// //               delete copy[deletedZoneId];
// //               return copy;
// //             });

// //             toast.success(`Zone deleted in real-time: ${deletedZoneId}`);
// //           }
// //         } catch (err) {
// //           console.error("❌ Failed to parse WebSocket message:", err);
// //         }
// //       };
// //     };

// //     connectWebSocket();

// //     return () => {
// //       if (wsRef.current) {
// //         wsRef.current.close();
// //       }
// //       if (reconnectTimeoutRef.current) {
// //         clearTimeout(reconnectTimeoutRef.current);
// //       }
// //     };
// //   }, [loadZones]);

// //   // Load logs on component mount
// //   useEffect(() => {
// //     fetchAllLogs();
// //   }, [fetchAllLogs]);

// //   // Cleanup on unmount
// //   useEffect(() => {
// //     return () => {
// //       clearZoneOverlays();
// //       if (assetMovementIntervalRef.current) {
// //         clearInterval(assetMovementIntervalRef.current);
// //       }
// //     };
// //   }, [clearZoneOverlays]);

// //   const toggleAssetMovement = useCallback(() => {
// //     setAssetMoving((prev) => !prev);
// //   }, []);

// //   const refreshZones = useCallback(() => {
// //     loadZones();
// //   }, [loadZones]);

// //   return (
// //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// //       <Typography variant="h4" gutterBottom>
// //         🗺️ Zone Manager
// //       </Typography>

// //       {/* Status indicators */}
// //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// //         <Chip
// //           label={`WebSocket: ${wsStatus}`}
// //           color={wsStatus === "Connected" ? "success" : "error"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         <Chip
// //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// //           color={assetMoving ? "primary" : "default"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         {currentZone && (
// //           <Chip
// //             label={`In Zone: ${currentZone.name}`}
// //             color="success"
// //             variant="filled"
// //             size="small"
// //           />
// //         )}
// //       </Box>

// //       {/* Loading indicator */}
// //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// //       {/* Map container */}
// //       <Box
// //         ref={mapRef}
// //         sx={{
// //           width: "100%",
// //           height: "500px",
// //           mb: 3,
// //           border: 1,
// //           borderColor: "grey.300",
// //           borderRadius: 1,
// //         }}
// //       />

// //       {/* Asset controls */}
// //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// //         <Button
// //           variant="outlined"
// //           onClick={toggleAssetMovement}
// //           color={assetMoving ? "error" : "success"}
// //         >
// //           {assetMoving ? "Stop Asset" : "Start Asset"}
// //         </Button>
// //         <Button
// //           variant="outlined"
// //           onClick={refreshZones}
// //           startIcon={<RefreshIcon />}
// //         >
// //           Refresh Zones
// //         </Button>
// //       </Box>

// //       {/* File upload section */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             📂 Upload GeoJSON Zone
// //           </Typography>
// //           <input
// //             type="file"
// //             ref={fileInputRef}
// //             accept=".geojson,application/geo+json"
// //             onChange={handleFileUpload}
// //             multiple
// //             disabled={loading}
// //             style={{ marginBottom: "16px" }}
// //           />
// //           {uploadStatus && (
// //             <Alert
// //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// //               sx={{ mt: 1 }}
// //             >
// //               {uploadStatus}
// //             </Alert>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Zones list */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             🗂️ Saved Zones ({zones.length})
// //           </Typography>

// //           {zones.length === 0 ? (
// //             <Typography color="text.secondary">
// //               No zones available. Draw zones on the map or upload GeoJSON files.
// //             </Typography>
// //           ) : (
// //             <Grid container spacing={2}>
// //               {zones.map((zone) => (
// //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// //                   <Card variant="outlined">
// //                     <CardContent
// //                       sx={{
// //                         display: "flex",
// //                         justifyContent: "space-between",
// //                         alignItems: "center",
// //                       }}
// //                     >
// //                       <Box>
// //                         <Typography variant="subtitle1" gutterBottom>
// //                           {zone.name}
// //                         </Typography>
// //                         <Typography variant="body2" color="text.secondary">
// //                           Type: {zone.geojson.type}
// //                         </Typography>
// //                         {zone.created_at && (
// //                           <Typography variant="caption" color="text.secondary">
// //                             Created:{" "}
// //                             {new Date(zone.created_at).toLocaleDateString()}
// //                           </Typography>
// //                         )}
// //                       </Box>
// //                       <Box>
// //                         <label>
// //                           <input
// //                             type="checkbox"
// //                             checked={zoneVisibility[zone.id] ?? true}
// //                             onChange={() => toggleZoneVisibility(zone.id)}
// //                           />{" "}
// //                           Visible
// //                         </label>
// //                       </Box>
// //                     </CardContent>

// //                     <CardActions>
// //                       <Tooltip title="Delete zone">
// //                         <IconButton
// //                           color="error"
// //                           onClick={() => handleDelete(zone.id)}
// //                           disabled={loading}
// //                         >
// //                           <DeleteIcon />
// //                         </IconButton>
// //                       </Tooltip>
// //                     </CardActions>
// //                   </Card>
// //                 </Grid>
// //               ))}
// //             </Grid>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Event log */}
// //       <Grid container spacing={3}>
// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📋 Recent Events
// //               </Typography>
// //               {eventLog.length === 0 ? (
// //                 <Typography color="text.secondary">
// //                   No recent events.
// //                 </Typography>
// //               ) : (
// //                 <List dense>
// //                   {eventLog.map((event, idx) => (
// //                     <ListItem key={idx}>
// //                       <ListItemText
// //                         primary={`${event.type} - ${event.zone}`}
// //                         secondary={new Date(event.time).toLocaleString()}
// //                       />
// //                     </ListItem>
// //                   ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>

// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📜 Full Log History
// //               </Typography>

// //               {/* Zone Filter Dropdown */}
// //               <Box sx={{ mb: 2 }}>
// //                 <Typography variant="body2" sx={{ mb: 1 }}>
// //                   Filter Logs by Zone:
// //                 </Typography>
// //                 <Select
// //                   size="small"
// //                   value={selectedZoneFilter}
// //                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
// //                   displayEmpty
// //                   sx={{ minWidth: 200 }}
// //                 >
// //                   <MenuItem value="All">All</MenuItem>
// //                   {zones.map((zone) => (
// //                     <MenuItem key={zone.id} value={zone.name}>
// //                       {zone.name}
// //                     </MenuItem>
// //                   ))}
// //                 </Select>
// //               </Box>

// //               {/* Filtered Logs List */}
// //               {allLogs.length === 0 ? (
// //                 <Typography color="text.secondary">No logs found.</Typography>
// //               ) : (
// //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// //                   {allLogs
// //                     .filter(
// //                       (log) =>
// //                         selectedZoneFilter === "All" ||
// //                         log.zoneName === selectedZoneFilter
// //                     )
// //                     .slice(0, 50)
// //                     .map((log, idx) => (
// //                       <ListItem key={log.id || idx}>
// //                         <ListItemText
// //                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// //                           secondary={new Date(log.timestamp).toLocaleString()}
// //                         />
// //                       </ListItem>
// //                     ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>
// //       </Grid>

// //       {/* Asset position debug info */}
// //       <Box sx={{ mt: 3 }}>
// //         <Typography variant="caption" color="text.secondary">
// //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// //           {assetPosition.lng.toFixed(6)}
// //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// //         </Typography>
// //       </Box>
// //     </Box>
// //   );
// // };

// // export default ZoneManager;

// // import React, { useEffect, useRef, useState, useCallback } from "react";
// // import {
// //   Box,
// //   Typography,
// //   Button,
// //   Divider,
// //   List,
// //   ListItem,
// //   ListItemText,
// //   Alert,
// //   LinearProgress,
// //   Chip,
// //   Card,
// //   CardContent,
// //   CardActions,
// //   Grid,
// //   IconButton,
// //   Tooltip,
// //   Select,
// //   MenuItem,
// // } from "@mui/material";
// // import DeleteIcon from "@mui/icons-material/Delete";
// // import RefreshIcon from "@mui/icons-material/Refresh";
// // import * as turf from "@turf/turf";
// // import * as geojsonValidation from "geojson-validation";
// // import { z } from "zod";
// // import toast from "react-hot-toast";

// // // tieminterval calculate
// // import dayjs from "dayjs";
// // import duration from "dayjs/plugin/duration";
// // dayjs.extend(duration);

// // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // const WS_URL =
// //   process.env.REACT_APP_WS_URL ||
// //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // function apiUrl(path) {
// //   return `${API_BASE_URL}${path}`;
// // }

// // // Enhanced validation schemas
// // const LatLngSchema = z.object({
// //   lat: z.number().min(-90).max(90),
// //   lng: z.number().min(-180).max(180),
// // });

// // const ZoneSchema = z.object({
// //   id: z.string(),
// //   name: z.string().min(1),
// //   geojson: z.object({
// //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// //     coordinates: z.array(z.any()),
// //   }),
// //   created_at: z.string().optional(),
// // });

// // const ZoneManager = () => {
// //   const mapRef = useRef(null);
// //   const markerRef = useRef(null);
// //   const mapInstanceRef = useRef(null);
// //   const fileInputRef = useRef(null);
// //   const zoneOverlaysRef = useRef([]);
// //   const lastZoneRef = useRef(null);
// //   const wsRef = useRef(null);
// //   const reconnectTimeoutRef = useRef(null);
// //   const assetMovementIntervalRef = useRef(null);
// //   const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

// //   // State management
// //   const [mapLoaded, setMapLoaded] = useState(false);
// //   const [zones, setZones] = useState([]);
// //   const [uploadStatus, setUploadStatus] = useState("");
// //   const [loading, setLoading] = useState(false);
// //   const [wsStatus, setWsStatus] = useState("Disconnected");
// //   const [assetPosition, setAssetPosition] = useState({
// //     lat: 40.7825,
// //     lng: -73.965,
// //   });
// //   const [inZone, setInZone] = useState(false);
// //   const [eventLog, setEventLog] = useState([]);
// //   const [allLogs, setAllLogs] = useState([]);
// //   const [currentZone, setCurrentZone] = useState(null);
// //   const [assetMoving, setAssetMoving] = useState(true);
// //   const [zoneVisibility, setZoneVisibility] = useState({});
// //   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
// //   const [zoneEntryTime, setZoneEntryTime] = useState(null); // ⏱️ Zone entry timestamp

// //   // Clear existing zone overlays from map
// //   const clearZoneOverlays = useCallback(() => {
// //     zoneOverlaysRef.current.forEach((overlay) => {
// //       if (overlay && overlay.setMap) {
// //         overlay.setMap(null);
// //       }
// //     });
// //     zoneOverlaysRef.current = [];
// //   }, []);

// //   // Load Google Maps API
// //   useEffect(() => {
// //     if (!window.google && !document.getElementById("google-maps-script")) {
// //       const script = document.createElement("script");
// //       script.id = "google-maps-script";
// //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// //       script.async = true;
// //       script.defer = true;
// //       script.onload = () => setMapLoaded(true);
// //       script.onerror = () => {
// //         console.error("Failed to load Google Maps API");
// //         toast.error("Failed to load Google Maps API");
// //       };
// //       document.body.appendChild(script);
// //     } else if (window.google) {
// //       setMapLoaded(true);
// //     }
// //   }, []);

// //   // Initialize map when loaded
// //   useEffect(() => {
// //     if (mapLoaded && mapRef.current) {
// //       initMap();
// //     }
// //   }, [mapLoaded]);

// //   const initMap = useCallback(() => {
// //     if (!mapRef.current || !window.google) return;

// //     const map = new window.google.maps.Map(mapRef.current, {
// //       center: { lat: 40.7829, lng: -73.9654 },
// //       zoom: 15,
// //       mapTypeControl: true,
// //       streetViewControl: true,
// //       fullscreenControl: true,
// //     });
// //     mapInstanceRef.current = map;

// //     // Initialize drawing manager
// //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// //       drawingMode: null,
// //       drawingControl: true,
// //       drawingControlOptions: {
// //         position: window.google.maps.ControlPosition.TOP_CENTER,
// //         drawingModes: [
// //           window.google.maps.drawing.OverlayType.POLYGON,
// //           window.google.maps.drawing.OverlayType.POLYLINE,
// //           window.google.maps.drawing.OverlayType.CIRCLE,
// //           window.google.maps.drawing.OverlayType.RECTANGLE,
// //         ],
// //       },
// //       polygonOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       polylineOptions: {
// //         strokeColor: "#2196F3",
// //         strokeWeight: 3,
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       rectangleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       circleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //     });

// //     drawingManager.setMap(map);

// //     // Handle drawing completion
// //     window.google.maps.event.addListener(
// //       drawingManager,
// //       "overlaycomplete",
// //       handleDrawingComplete
// //     );

// //     // Load existing zones
// //     loadZones(map);
// //   }, []);

// //   const handleDrawingComplete = useCallback(async (event) => {
// //     let geojson;
// //     const name = prompt("Enter Zone Name");

// //     if (!name || name.trim() === "") {
// //       alert("Zone name cannot be empty.");
// //       event.overlay.setMap(null);
// //       return;
// //     }

// //     try {
// //       switch (event.type) {
// //         case "polygon": {
// //           const polygon = event.overlay;
// //           const path = polygon.getPath().getArray();
// //           if (path.length < 3) {
// //             throw new Error("Polygon must have at least 3 points.");
// //           }
// //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// //           coordinates.push(coordinates[0]); // Close polygon

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         case "polyline": {
// //           const polyline = event.overlay;
// //           const path = polyline.getPath().getArray();
// //           if (path.length < 2) {
// //             throw new Error("Line must have at least 2 points.");
// //           }
// //           const coordinates = path.map((latLng) => [
// //             latLng.lng(),
// //             latLng.lat(),
// //           ]);

// //           geojson = {
// //             type: "LineString",
// //             coordinates,
// //           };
// //           break;
// //         }

// //         case "circle": {
// //           const circle = event.overlay;
// //           const center = circle.getCenter();
// //           const radius = circle.getRadius();

// //           const points = [];
// //           const numPoints = 64;
// //           for (let i = 0; i < numPoints; i++) {
// //             const angle = (i / numPoints) * 2 * Math.PI;
// //             const point = turf.destination(
// //               turf.point([center.lng(), center.lat()]),
// //               radius / 1000,
// //               (angle * 180) / Math.PI,
// //               { units: "kilometers" }
// //             );
// //             points.push(point.geometry.coordinates);
// //           }
// //           points.push(points[0]);

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [points],
// //           };
// //           break;
// //         }

// //         case "rectangle": {
// //           const rectangle = event.overlay;
// //           const bounds = rectangle.getBounds();
// //           const ne = bounds.getNorthEast();
// //           const sw = bounds.getSouthWest();
// //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// //           const coordinates = [
// //             [sw.lng(), sw.lat()],
// //             [nw.lng(), nw.lat()],
// //             [ne.lng(), ne.lat()],
// //             [se.lng(), se.lat()],
// //             [sw.lng(), sw.lat()],
// //           ];

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         default:
// //           throw new Error("Unsupported shape type");
// //       }

// //       // Validate GeoJSON
// //       if (
// //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// //         (geojson.type === "LineString" &&
// //           !geojsonValidation.isLineString(geojson))
// //       ) {
// //         throw new Error("Invalid GeoJSON shape. Please try again.");
// //       }

// //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// //       event.overlay.setMap(null);

// //       await saveZone(name.trim(), geojson);
// //     } catch (error) {
// //       console.error("Drawing error:", error);
// //       alert(error.message);
// //       event.overlay.setMap(null);
// //     }
// //   }, []);

// //   const saveZone = useCallback(async (name, geojson) => {
// //     setLoading(true);
// //     try {
// //       const res = await fetch(apiUrl("/zone"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify({ name, geojson }),
// //       });

// //       if (!res.ok) {
// //         const errorData = await res.json().catch(() => ({}));
// //         throw new Error(
// //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// //         );
// //       }

// //       const result = await res.json();
// //       console.log("Zone saved:", name);

// //       // Broadcast zone update via WebSocket
// //       // 🔄 Broadcast delete to other users
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         wsRef.current.send(
// //           JSON.stringify({
// //             action: "default",
// //             type: "zone-delete",
// //             zoneId: id,
// //           })
// //         );
// //       }

// //       toast.success("Zone added successfully!");
// //       await loadZones(); // Reload zones
// //     } catch (err) {
// //       console.error("Failed to save zone:", err);
// //       toast.error(`Failed to save zone: ${err.message}`);
// //     } finally {
// //       setLoading(false);
// //     }
// //   }, []);

// //   const loadZones = useCallback(
// //     async (mapInstance) => {
// //       try {
// //         const res = await fetch(apiUrl("/zones"));
// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         const data = await res.json();

// //         // Validate zones data
// //         const validatedZones = data.filter((zone) => {
// //           try {
// //             ZoneSchema.parse(zone);
// //             return true;
// //           } catch (error) {
// //             console.warn("Invalid zone data:", zone, error);
// //             return false;
// //           }
// //         });

// //         setZones(validatedZones);

// //         const map = mapInstance || mapInstanceRef.current;
// //         if (!map) return;

// //         // Clear existing zone overlays before adding new ones
// //         clearZoneOverlays();

// //         // Add new zone overlays
// //         validatedZones.forEach((zone) => {
// //           let overlay;

// //           if (zone.geojson.type === "Polygon") {
// //             overlay = new window.google.maps.Polygon({
// //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 2,
// //               fillColor: "#FF0000",
// //               fillOpacity: 0.2,
// //             });
// //           } else if (zone.geojson.type === "LineString") {
// //             overlay = new window.google.maps.Polyline({
// //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 3,
// //             });
// //           }

// //           if (overlay) {
// //             overlay.setMap(map); // Show on map initially

// //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// //             // ✅ Track visibility status
// //             setZoneVisibility((prev) => ({
// //               ...prev,
// //               [zone.id]: true,
// //             }));

// //             // Add click listener for zone info
// //             overlay.addListener("click", () => {
// //               const infoWindow = new window.google.maps.InfoWindow({
// //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// //               });

// //               const position =
// //                 overlay.getPath?.().getAt(0) ??
// //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// //               if (position) {
// //                 infoWindow.setPosition(position);
// //                 infoWindow.open(map);
// //               }
// //             });
// //           }
// //         });
// //       } catch (err) {
// //         console.error("Failed to load zones:", err);
// //         toast.error("Failed to load zones");
// //       }
// //     },
// //     [clearZoneOverlays]
// //   );

// //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// //     const timestamp = new Date().toISOString();

// //     const body = {
// //       type: eventType,
// //       zoneId: zone.id,
// //       zoneName: zone.name,
// //       geojson: zone.geojson,
// //       point: point.geometry.coordinates,
// //       timestamp,
// //     };

// //     try {
// //       const res = await fetch(apiUrl("/alert"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify(body),
// //       });

// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       console.log("✅ Email alert sent:", body);
// //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// //     } catch (err) {
// //       console.error("❌ Failed to send email alert:", err);
// //       toast.error("Failed to send alert");
// //     }
// //   }, []);

// //   const logEventToDB = useCallback(
// //     async (type, zoneName, zoneId, timestamp) => {
// //       try {
// //         const res = await fetch(apiUrl("/log-event"), {
// //           method: "POST",
// //           headers: { "Content-Type": "application/json" },
// //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// //         });

// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         console.log("✅ Log saved to DB");
// //       } catch (err) {
// //         console.error("❌ Failed to save log to DB:", err);
// //       }
// //     },
// //     []
// //   );

// //   const handleDelete = useCallback(async (id) => {
// //     if (!window.confirm("Are you sure you want to delete this zone?")) return;

// //     setLoading(true);
// //     try {
// //       const res = await fetch(apiUrl(`/zone/${id}`), {
// //         method: "DELETE",
// //       });

// //       if (!res.ok) {
// //         throw new Error(`Failed to delete zone: ${res.status}`);
// //       }

// //       // ✅ Remove from state
// //       setZones((prev) => prev.filter((zone) => zone.id !== id));

// //       // ✅ Also remove from map overlays manually
// //       const newOverlays = zoneOverlaysRef.current.filter((z) => {
// //         if (z.id === id) {
// //           z.overlay.setMap(null);
// //           return false;
// //         }
// //         return true;
// //       });
// //       zoneOverlaysRef.current = newOverlays;

// //       zoneOverlaysRef.current = newOverlays;

// //       toast.success("Zone deleted successfully");
// //     } catch (err) {
// //       console.error("Delete error:", err);
// //       toast.error(`Error deleting zone`);
// //     } finally {
// //       setLoading(false);
// //     }
// //   }, []);

// //   const handleFileUpload = useCallback(
// //     async (event) => {
// //       const files = event.target.files;
// //       if (!files || files.length === 0) return;

// //       setLoading(true);
// //       let successCount = 0;
// //       let errorCount = 0;

// //       for (let file of files) {
// //         try {
// //           const text = await file.text();
// //           const json = JSON.parse(text);

// //           if (
// //             !geojsonValidation.isPolygon(json) &&
// //             !geojsonValidation.isMultiPolygon(json) &&
// //             !geojsonValidation.isLineString(json)
// //           ) {
// //             throw new Error(
// //               "Only Polygon, MultiPolygon, or LineString supported"
// //             );
// //           }

// //           const name =
// //             prompt(`Enter a name for zone in ${file.name}`) ||
// //             file.name.replace(".geojson", "");

// //           if (!name || name.trim() === "") {
// //             throw new Error("Zone name is required");
// //           }

// //           await saveZone(name.trim(), json);
// //           successCount++;
// //         } catch (err) {
// //           console.error(`Error processing ${file.name}:`, err);
// //           errorCount++;
// //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// //         }
// //       }

// //       if (successCount > 0) {
// //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// //       }
// //       if (errorCount > 0) {
// //         toast.error(`Failed to upload ${errorCount} files`);
// //       }

// //       if (fileInputRef.current) {
// //         fileInputRef.current.value = "";
// //       }

// //       setLoading(false);
// //     },
// //     [saveZone]
// //   );

// //   const fetchAllLogs = useCallback(async () => {
// //     try {
// //       const res = await fetch(apiUrl("/logs"));
// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       const data = await res.json();
// //       setAllLogs(
// //         data.sort(
// //           (a, b) =>
// //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// //         )
// //       );
// //     } catch (err) {
// //       console.error("Failed to fetch logs:", err);
// //       toast.error("Failed to fetch logs");
// //     }
// //   }, []);

// //   const toggleZoneVisibility = useCallback((zoneId) => {
// //     setZoneVisibility((prev) => {
// //       const newVisibility = !prev[zoneId];

// //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// //       if (overlayObj && overlayObj.overlay) {
// //         overlayObj.overlay.setMap(
// //           newVisibility ? mapInstanceRef.current : null
// //         );
// //       }

// //       return {
// //         ...prev,
// //         [zoneId]: newVisibility,
// //       };
// //     });
// //   }, []);

// //   // Asset movement and geofencing logic
// //   useEffect(() => {
// //     if (
// //       !mapLoaded ||
// //       zones.length === 0 ||
// //       !mapInstanceRef.current ||
// //       !assetMoving
// //     )
// //       return;

// //     const interval = setInterval(() => {
// //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// //       setAssetPosition((prev) => {
// //         const newPos = {
// //           lat: prev.lat + deltaLat,
// //           lng: prev.lng + deltaLng,
// //         };

// //         try {
// //           LatLngSchema.parse(newPos);
// //         } catch (err) {
// //           console.warn("Invalid coordinates, skipping...");
// //           return prev;
// //         }

// //         const point = turf.point([newPos.lng, newPos.lat]);
// //         let matchedZone = null;

// //         // Check all zones for intersection
// //         for (let zone of zones) {
// //           if (zone.geojson.type === "Polygon") {
// //             try {
// //               const polygon = turf.polygon(zone.geojson.coordinates);
// //               if (turf.booleanPointInPolygon(point, polygon)) {
// //                 matchedZone = zone;
// //                 break;
// //               }
// //             } catch (error) {
// //               console.warn("Error checking zone intersection:", error);
// //             }
// //           }
// //         }

// //         const inside = Boolean(matchedZone);
// //         const wasInside = Boolean(lastZoneRef.current);

// //         const ts = new Date().toISOString();

// //         if (inside && !wasInside) {
// //           // Entering a zone
// //           lastZoneRef.current = matchedZone;
// //           zoneEntryTimeRef.current = ts; // ✅ Use ref instead of setState
// //           setInZone(true);
// //           setCurrentZone(matchedZone);

// //           setEventLog((prev) => [
// //             { type: "Entered", zone: matchedZone.name, time: ts },
// //             ...prev.slice(0, 9),
// //           ]);

// //           toast.success(`🚧 Entered zone ${matchedZone.name}`);
// //           sendEmailAlert("ENTER", matchedZone, point);
// //           fetchAllLogs();
// //         } else if (!inside && wasInside) {
// //           // Exiting a zone
// //           const exitedZone = lastZoneRef.current;
// //           lastZoneRef.current = null;
// //           setInZone(false);
// //           setCurrentZone(null);

// //           const durationMs = dayjs(ts).diff(dayjs(zoneEntryTimeRef.current));
// //           const durationStr = dayjs.duration(durationMs).humanize();
// //           const logMessage = `Stayed for ${durationStr}`;

// //           setEventLog((prev) => [
// //             {
// //               type: `Exited`,
// //               zone: exitedZone?.name || "Unknown",
// //               time: ts,
// //               duration: logMessage,
// //             },
// //             ...prev.slice(0, 9),
// //           ]);

// //           toast.success(
// //             `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
// //           );
// //           sendEmailAlert("EXIT", exitedZone || {}, point);
// //           fetchAllLogs();
// //         }

// //         // Update marker
// //         const map = mapInstanceRef.current;
// //         if (!markerRef.current && map) {
// //           markerRef.current = new window.google.maps.Marker({
// //             map,
// //             title: "Asset Tracker",
// //             icon: {
// //               path: window.google.maps.SymbolPath.CIRCLE,
// //               scale: 8,
// //               fillColor: matchedZone ? "#4CAF50" : "#F44336",
// //               fillOpacity: 1,
// //               strokeWeight: 2,
// //               strokeColor: "#FFFFFF",
// //             },
// //           });
// //         }

// //         if (markerRef.current) {
// //           markerRef.current.setIcon({
// //             path: window.google.maps.SymbolPath.CIRCLE,
// //             scale: 8,
// //             fillColor: matchedZone ? "#4CAF50" : "#F44336",
// //             fillOpacity: 1,
// //             strokeWeight: 2,
// //             strokeColor: "#FFFFFF",
// //           });

// //           markerRef.current.setPosition(
// //             new window.google.maps.LatLng(newPos.lat, newPos.lng)
// //           );
// //         }

// //         return newPos;
// //       });
// //     }, 1000);

// //     assetMovementIntervalRef.current = interval;
// //     return () => clearInterval(interval);
// //   }, [zones, mapLoaded, assetMoving, sendEmailAlert, fetchAllLogs]);

// //   // WebSocket connection management
// //   useEffect(() => {
// //     const connectWebSocket = () => {
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         return;
// //       }

// //       const socket = new WebSocket(
// //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// //       );
// //       wsRef.current = socket;

// //       socket.onopen = () => {
// //         console.log("✅ WebSocket connected");
// //         setWsStatus("Connected");
// //         if (reconnectTimeoutRef.current) {
// //           clearTimeout(reconnectTimeoutRef.current);
// //           reconnectTimeoutRef.current = null;
// //         }
// //       };

// //       socket.onclose = () => {
// //         console.warn("❌ WebSocket disconnected");
// //         setWsStatus("Disconnected");

// //         // Attempt to reconnect after 5 seconds
// //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
// //       };

// //       socket.onerror = (err) => {
// //         console.error("🚨 WebSocket error", err);
// //         setWsStatus("Error");
// //       };

// //       socket.onmessage = (event) => {
// //         try {
// //           const data = JSON.parse(event.data);
// //           console.log("📨 WebSocket message received:", data);

// //           if (data.type === "zone-update") {
// //             console.log("🔄 Reloading zones due to update...");
// //             loadZones();
// //           } else if (data.type === "zone-delete") {
// //             console.log("🗑️ Zone deleted in real time:", data.zoneId);

// //             setZones((prev) => prev.filter((z) => z.id !== data.zoneId));

// //             // Remove from map
// //             const updatedOverlays = zoneOverlaysRef.current.filter((z) => {
// //               if (z.id === data.zoneId) {
// //                 z.overlay.setMap(null);
// //                 return false;
// //               }
// //               return true;
// //             });
// //             zoneOverlaysRef.current = updatedOverlays;

// //             // Clean up visibility toggle state
// //             setZoneVisibility((prev) => {
// //               const copy = { ...prev };
// //               delete copy[data.zoneId];
// //               return copy;
// //             });

// //             toast.success(`Zone deleted in real-time: ${data.zoneId}`);
// //           }
// //         } catch (err) {
// //           console.error("Failed to parse WebSocket message:", err);
// //         }
// //       };
// //     };

// //     connectWebSocket();

// //     return () => {
// //       if (wsRef.current) {
// //         wsRef.current.close();
// //       }
// //       if (reconnectTimeoutRef.current) {
// //         clearTimeout(reconnectTimeoutRef.current);
// //       }
// //     };
// //   }, [loadZones]);

// //   // Load logs on component mount
// //   useEffect(() => {
// //     fetchAllLogs();
// //   }, [fetchAllLogs]);

// //   // Cleanup on unmount
// //   useEffect(() => {
// //     return () => {
// //       clearZoneOverlays();
// //       if (assetMovementIntervalRef.current) {
// //         clearInterval(assetMovementIntervalRef.current);
// //       }
// //     };
// //   }, [clearZoneOverlays]);

// //   const toggleAssetMovement = useCallback(() => {
// //     setAssetMoving((prev) => !prev);
// //   }, []);

// //   const refreshZones = useCallback(() => {
// //     loadZones();
// //   }, [loadZones]);

// //   return (
// //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// //       <Typography variant="h4" gutterBottom>
// //         🗺️ Zone Manager
// //       </Typography>

// //       {/* Status indicators */}
// //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// //         <Chip
// //           label={`WebSocket: ${wsStatus}`}
// //           color={wsStatus === "Connected" ? "success" : "error"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         <Chip
// //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// //           color={assetMoving ? "primary" : "default"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         {currentZone && (
// //           <Chip
// //             label={`In Zone: ${currentZone.name}`}
// //             color="success"
// //             variant="filled"
// //             size="small"
// //           />
// //         )}
// //       </Box>

// //       {/* Loading indicator */}
// //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// //       {/* Map container */}
// //       <Box
// //         ref={mapRef}
// //         sx={{
// //           width: "100%",
// //           height: "500px",
// //           mb: 3,
// //           border: 1,
// //           borderColor: "grey.300",
// //           borderRadius: 1,
// //         }}
// //       />

// //       {/* Asset controls */}
// //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// //         <Button
// //           variant="outlined"
// //           onClick={toggleAssetMovement}
// //           color={assetMoving ? "error" : "success"}
// //         >
// //           {assetMoving ? "Stop Asset" : "Start Asset"}
// //         </Button>
// //         <Button
// //           variant="outlined"
// //           onClick={refreshZones}
// //           startIcon={<RefreshIcon />}
// //         >
// //           Refresh Zones
// //         </Button>
// //       </Box>

// //       {/* File upload section */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             📂 Upload GeoJSON Zone
// //           </Typography>
// //           <input
// //             type="file"
// //             ref={fileInputRef}
// //             accept=".geojson,application/geo+json"
// //             onChange={handleFileUpload}
// //             multiple
// //             disabled={loading}
// //             style={{ marginBottom: "16px" }}
// //           />
// //           {uploadStatus && (
// //             <Alert
// //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// //               sx={{ mt: 1 }}
// //             >
// //               {uploadStatus}
// //             </Alert>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Zones list */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             🗂️ Saved Zones ({zones.length})
// //           </Typography>

// //           {zones.length === 0 ? (
// //             <Typography color="text.secondary">
// //               No zones available. Draw zones on the map or upload GeoJSON files.
// //             </Typography>
// //           ) : (
// //             <Grid container spacing={2}>
// //               {zones.map((zone) => (
// //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// //                   <Card variant="outlined">
// //                     <CardContent
// //                       sx={{
// //                         display: "flex",
// //                         justifyContent: "space-between",
// //                         alignItems: "center",
// //                       }}
// //                     >
// //                       <Box>
// //                         <Typography variant="subtitle1" gutterBottom>
// //                           {zone.name}
// //                         </Typography>
// //                         <Typography variant="body2" color="text.secondary">
// //                           Type: {zone.geojson.type}
// //                         </Typography>
// //                         {zone.created_at && (
// //                           <Typography variant="caption" color="text.secondary">
// //                             Created:{" "}
// //                             {new Date(zone.created_at).toLocaleDateString()}
// //                           </Typography>
// //                         )}
// //                       </Box>
// //                       <Box>
// //                         <label>
// //                           <input
// //                             type="checkbox"
// //                             checked={zoneVisibility[zone.id] ?? true}
// //                             onChange={() => toggleZoneVisibility(zone.id)}
// //                           />{" "}
// //                           Visible
// //                         </label>
// //                       </Box>
// //                     </CardContent>

// //                     <CardActions>
// //                       <Tooltip title="Delete zone">
// //                         <IconButton
// //                           color="error"
// //                           onClick={() => handleDelete(zone.id)}
// //                           disabled={loading}
// //                         >
// //                           <DeleteIcon />
// //                         </IconButton>
// //                       </Tooltip>
// //                     </CardActions>
// //                   </Card>
// //                 </Grid>
// //               ))}
// //             </Grid>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Event log */}
// //       <Grid container spacing={3}>
// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📋 Recent Events
// //               </Typography>
// //               {eventLog.length === 0 ? (
// //                 <Typography color="text.secondary">
// //                   No recent events.
// //                 </Typography>
// //               ) : (
// //                 <List dense>
// //                   {eventLog.map((event, idx) => (
// //                     <ListItem key={idx}>
// //                       <ListItemText
// //                         primary={`${event.type} - ${event.zone}`}
// //                         secondary={new Date(event.time).toLocaleString()}
// //                       />
// //                     </ListItem>
// //                   ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>

// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📜 Full Log History
// //               </Typography>

// //               {/* Zone Filter Dropdown */}
// //               <Box sx={{ mb: 2 }}>
// //                 <Typography variant="body2" sx={{ mb: 1 }}>
// //                   Filter Logs by Zone:
// //                 </Typography>
// //                 <Select
// //                   size="small"
// //                   value={selectedZoneFilter}
// //                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
// //                   displayEmpty
// //                   sx={{ minWidth: 200 }}
// //                 >
// //                   <MenuItem value="All">All</MenuItem>
// //                   {zones.map((zone) => (
// //                     <MenuItem key={zone.id} value={zone.name}>
// //                       {zone.name}
// //                     </MenuItem>
// //                   ))}
// //                 </Select>
// //               </Box>

// //               {/* Filtered Logs List */}
// //               {allLogs.length === 0 ? (
// //                 <Typography color="text.secondary">No logs found.</Typography>
// //               ) : (
// //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// //                   {allLogs
// //                     .filter(
// //                       (log) =>
// //                         selectedZoneFilter === "All" ||
// //                         log.zoneName === selectedZoneFilter
// //                     )
// //                     .slice(0, 50)
// //                     .map((log, idx) => (
// //                       <ListItem key={log.id || idx}>
// //                         <ListItemText
// //                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// //                           secondary={new Date(log.timestamp).toLocaleString()}
// //                         />
// //                       </ListItem>
// //                     ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>
// //       </Grid>

// //       {/* Asset position debug info */}
// //       <Box sx={{ mt: 3 }}>
// //         <Typography variant="caption" color="text.secondary">
// //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// //           {assetPosition.lng.toFixed(6)}
// //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// //         </Typography>
// //       </Box>

// //       <List dense>
// //         {eventLog.map((event, idx) => (
// //           <ListItem key={idx}>
// //             <ListItemText
// //               primary={`${event.type} - ${event.zone}`}
// //               secondary={
// //                 event.duration
// //                   ? `${new Date(event.time).toLocaleString()} | ${
// //                       event.duration
// //                     }`
// //                   : new Date(event.time).toLocaleString()
// //               }
// //             />
// //           </ListItem>
// //         ))}
// //       </List>
// //     </Box>
// //   );
// // };

// // export default ZoneManager;


// // import React, { useEffect, useRef, useState, useCallback } from "react";
// // import {
// //   Box,
// //   Typography,
// //   Button,
// //   Divider,
// //   List,
// //   ListItem,
// //   ListItemText,
// //   Alert,
// //   LinearProgress,
// //   Chip,
// //   Card,
// //   CardContent,
// //   CardActions,
// //   Grid,
// //   IconButton,
// //   Tooltip,
// //   Select,
// //   MenuItem,
// // } from "@mui/material";
// // import DeleteIcon from "@mui/icons-material/Delete";
// // import RefreshIcon from "@mui/icons-material/Refresh";
// // import * as turf from "@turf/turf";
// // import * as geojsonValidation from "geojson-validation";
// // import { z } from "zod";
// // import toast from "react-hot-toast";

// // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // const WS_API_ENDPOINT =
// //   process.env.REACT_APP_WS_URL ||
// //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // function apiUrl(path) {
// //   return `${API_BASE_URL}${path}`;
// // }

// // // Enhanced validation schemas
// // const LatLngSchema = z.object({
// //   lat: z.number().min(-90).max(90),
// //   lng: z.number().min(-180).max(180),
// // });

// // const ZoneSchema = z.object({
// //   id: z.string(),
// //   name: z.string().min(1),
// //   geojson: z.object({
// //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// //     coordinates: z.array(z.any()),
// //   }),
// //   created_at: z.string().optional(),
// // });

// // const ZoneManager = () => {
// //   const mapRef = useRef(null);
// //   const markerRef = useRef(null);
// //   const mapInstanceRef = useRef(null);
// //   const fileInputRef = useRef(null);
// //   const zoneOverlaysRef = useRef([]);
// //   const lastZoneRef = useRef(null);
// //   const wsRef = useRef(null);
// //   const reconnectTimeoutRef = useRef(null);
// //   const assetMovementIntervalRef = useRef(null);
// //   const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

// //   // State management
// //   const [mapLoaded, setMapLoaded] = useState(false);
// //   const [zones, setZones] = useState([]);
// //   const [uploadStatus, setUploadStatus] = useState("");
// //   const [loading, setLoading] = useState(false);
// //   const [wsStatus, setWsStatus] = useState("Disconnected");
// //   const [assetPosition, setAssetPosition] = useState({
// //     lat: 40.7825,
// //     lng: -73.965,
// //   });
// //   const [inZone, setInZone] = useState(false);
// //   const [eventLog, setEventLog] = useState([]);
// //   const [allLogs, setAllLogs] = useState([]);
// //   const [currentZone, setCurrentZone] = useState(null);
// //   const [assetMoving, setAssetMoving] = useState(true);
// //   const [zoneVisibility, setZoneVisibility] = useState({});
// //   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
// //   const [assetLocation, setAssetLocation] = useState(null);

// //   // Clear existing zone overlays from map
// //   const clearZoneOverlays = useCallback(() => {
// //     zoneOverlaysRef.current.forEach(({ overlay }) => {
// //       overlay?.setMap(null);
// //     });
// //     zoneOverlaysRef.current = [];
// //   }, []);

// //   // Load Google Maps API
// //   useEffect(() => {
// //     if (!window.google && !document.getElementById("google-maps-script")) {
// //       const script = document.createElement("script");
// //       script.id = "google-maps-script";
// //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// //       script.async = true;
// //       script.defer = true;
// //       script.onload = () => setMapLoaded(true);
// //       script.onerror = () => {
// //         console.error("Failed to load Google Maps API");
// //         toast.error("Failed to load Google Maps API");
// //       };
// //       document.body.appendChild(script);
// //     } else if (window.google) {
// //       setMapLoaded(true);
// //     }
// //   }, []);
// //   const handleDrawingComplete = useCallback(async (event) => {
// //     let geojson;
// //     const name = prompt("Enter Zone Name");

// //     if (!name || name.trim() === "") {
// //       alert("Zone name cannot be empty.");
// //       event.overlay.setMap(null);
// //       return;
// //     }

// //     try {
// //       switch (event.type) {
// //         case "polygon": {
// //           const polygon = event.overlay;
// //           const path = polygon.getPath().getArray();
// //           if (path.length < 3) {
// //             throw new Error("Polygon must have at least 3 points.");
// //           }
// //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// //           coordinates.push(coordinates[0]); // Close polygon

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         case "polyline": {
// //           const polyline = event.overlay;
// //           const path = polyline.getPath().getArray();
// //           if (path.length < 2) {
// //             throw new Error("Line must have at least 2 points.");
// //           }
// //           const coordinates = path.map((latLng) => [
// //             latLng.lng(),
// //             latLng.lat(),
// //           ]);

// //           geojson = {
// //             type: "LineString",
// //             coordinates,
// //           };
// //           break;
// //         }

// //         case "circle": {
// //           const circle = event.overlay;
// //           const center = circle.getCenter();
// //           const radius = circle.getRadius();

// //           const points = [];
// //           const numPoints = 64;
// //           for (let i = 0; i < numPoints; i++) {
// //             const angle = (i / numPoints) * 2 * Math.PI;
// //             const point = turf.destination(
// //               turf.point([center.lng(), center.lat()]),
// //               radius / 1000,
// //               (angle * 180) / Math.PI,
// //               { units: "kilometers" }
// //             );
// //             points.push(point.geometry.coordinates);
// //           }
// //           points.push(points[0]);

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [points],
// //           };
// //           break;
// //         }

// //         case "rectangle": {
// //           const rectangle = event.overlay;
// //           const bounds = rectangle.getBounds();
// //           const ne = bounds.getNorthEast();
// //           const sw = bounds.getSouthWest();
// //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// //           const coordinates = [
// //             [sw.lng(), sw.lat()],
// //             [nw.lng(), nw.lat()],
// //             [ne.lng(), ne.lat()],
// //             [se.lng(), se.lat()],
// //             [sw.lng(), sw.lat()],
// //           ];

// //           geojson = {
// //             type: "Polygon",
// //             coordinates: [coordinates],
// //           };
// //           break;
// //         }

// //         default:
// //           throw new Error("Unsupported shape type");
// //       }

// //       // Validate GeoJSON
// //       if (
// //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// //         (geojson.type === "LineString" &&
// //           !geojsonValidation.isLineString(geojson))
// //       ) {
// //         throw new Error("Invalid GeoJSON shape. Please try again.");
// //       }

// //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// //       event.overlay.setMap(null);

// //       await saveZone(name.trim(), geojson);
// //     } catch (error) {
// //       console.error("Drawing error:", error);
// //       alert(error.message);
// //       event.overlay.setMap(null);
// //     }
// //   }, []);
// //   const loadZones = useCallback(
// //     async (mapInstance) => {
// //       try {
// //         const res = await fetch(apiUrl("/zones"));
// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         const data = await res.json();

// //         // Validate zones data
// //         const validatedZones = data.filter((zone) => {
// //           try {
// //             ZoneSchema.parse(zone);
// //             return true;
// //           } catch (error) {
// //             console.warn("Invalid zone data:", zone, error);
// //             return false;
// //           }
// //         });

// //         setZones(validatedZones);

// //         const map = mapInstance || mapInstanceRef.current;
// //         if (!map) return;

// //         // Clear existing zone overlays before adding new ones
// //         clearZoneOverlays();

// //         // Add new zone overlays
// //         validatedZones.forEach((zone) => {
// //           let overlay;

// //           if (zone.geojson.type === "Polygon") {
// //             overlay = new window.google.maps.Polygon({
// //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 2,
// //               fillColor: "#FF0000",
// //               fillOpacity: 0.2,
// //             });
// //           } else if (zone.geojson.type === "LineString") {
// //             overlay = new window.google.maps.Polyline({
// //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// //                 lat,
// //                 lng,
// //               })),
// //               strokeColor: "#FF0000",
// //               strokeOpacity: 0.8,
// //               strokeWeight: 3,
// //             });
// //           }

// //           if (overlay) {
// //             overlay.setMap(map); // Show on map initially

// //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// //             // ✅ Track visibility status
// //             setZoneVisibility((prev) => ({
// //               ...prev,
// //               [zone.id]: true,
// //             }));

// //             // Add click listener for zone info
// //             overlay.addListener("click", () => {
// //               const infoWindow = new window.google.maps.InfoWindow({
// //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// //               });

// //               const position =
// //                 overlay.getPath?.().getAt(0) ??
// //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// //               if (position) {
// //                 infoWindow.setPosition(position);
// //                 infoWindow.open(map);
// //               }
// //             });
// //           }
// //         });
// //       } catch (err) {
// //         console.error("Failed to load zones:", err);
// //         toast.error("Failed to load zones");
// //       }
// //     },
// //     [clearZoneOverlays]
// //   );

// //   const initMap = useCallback(() => {
// //     if (!mapRef.current || !window.google || mapInstanceRef.current) return; // ✅ prevent re-init

// //     const map = new window.google.maps.Map(mapRef.current, {
// //       center: { lat: 40.7829, lng: -73.9654 },
// //       zoom: 15,
// //       mapTypeControl: true,
// //       streetViewControl: true,
// //       fullscreenControl: true,
// //     });

// //     mapInstanceRef.current = map;

// //     // ✅ Initialize drawing manager once
// //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// //       drawingMode: null,
// //       drawingControl: true,
// //       drawingControlOptions: {
// //         position: window.google.maps.ControlPosition.TOP_CENTER,
// //         drawingModes: [
// //           window.google.maps.drawing.OverlayType.POLYGON,
// //           window.google.maps.drawing.OverlayType.POLYLINE,
// //           window.google.maps.drawing.OverlayType.CIRCLE,
// //           window.google.maps.drawing.OverlayType.RECTANGLE,
// //         ],
// //       },
// //       polygonOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       polylineOptions: {
// //         strokeColor: "#2196F3",
// //         strokeWeight: 3,
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       rectangleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //       circleOptions: {
// //         fillColor: "#2196F3",
// //         fillOpacity: 0.4,
// //         strokeWeight: 2,
// //         strokeColor: "#1976D2",
// //         clickable: true,
// //         editable: false,
// //         zIndex: 1,
// //       },
// //     });

// //     drawingManager.setMap(map);

// //     // Handle drawing completion
// //     window.google.maps.event.addListener(
// //       drawingManager,
// //       "overlaycomplete",
// //       handleDrawingComplete
// //     );

// //     // ✅ Load zones after initializing map
// //     loadZones(); // Don't pass map instance — use ref inside loadZones
// //   }, [handleDrawingComplete, loadZones]);

// //   // Initialize map when loaded
// //   useEffect(() => {
// //     if (mapLoaded && mapRef.current && !mapInstanceRef.current) {
// //       initMap();
// //     }
// //   }, [mapLoaded, initMap]);

// //   const saveZone = useCallback(async (name, geojson) => {
// //     setLoading(true);
// //     try {
// //       const res = await fetch(apiUrl("/zone"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify({ name, geojson }),
// //       });

// //       if (!res.ok) {
// //         const errorData = await res.json().catch(() => ({}));
// //         throw new Error(
// //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// //         );
// //       }

// //       const result = await res.json();
// //       console.log("Zone saved:", name);

// //       // Broadcast zone update via WebSocket
// //       // 🔄 Broadcast delete to other users
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         wsRef.current.send(
// //           JSON.stringify({
// //             action: "default",
// //             type: "zone-update",
// //             zoneName: name,
// //             timestamp: new Date().toISOString(),
// //           })
// //         );
// //       }

// //       toast.success("Zone added successfully!");
// //       await loadZones(); // Reload zones
// //     } catch (err) {
// //       console.error("Failed to save zone:", err);
// //       toast.error(`Failed to save zone: ${err.message}`);
// //     } finally {
// //       setLoading(false);
// //     }
// //   }, []);

// //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// //     const timestamp = new Date().toISOString();

// //     const body = {
// //       type: eventType,
// //       zoneId: zone.id,
// //       zoneName: zone.name,
// //       geojson: zone.geojson,
// //       point: point.geometry.coordinates,
// //       timestamp,
// //     };

// //     try {
// //       const res = await fetch(apiUrl("/alert"), {
// //         method: "POST",
// //         headers: { "Content-Type": "application/json" },
// //         body: JSON.stringify(body),
// //       });

// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       console.log("✅ Email alert sent:", body);
// //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// //     } catch (err) {
// //       console.error("❌ Failed to send email alert:", err);
// //       toast.error("Failed to send alert");
// //     }
// //   }, []);

// //   const logEventToDB = useCallback(
// //     async (type, zoneName, zoneId, timestamp) => {
// //       try {
// //         const res = await fetch(apiUrl("/log-event"), {
// //           method: "POST",
// //           headers: { "Content-Type": "application/json" },
// //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// //         });

// //         if (!res.ok) {
// //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //         }

// //         console.log("✅ Log saved to DB");
// //       } catch (err) {
// //         console.error("❌ Failed to save log to DB:", err);
// //       }
// //     },
// //     []
// //   );

// //   const handleDelete = async (zoneId) => {
// //     try {
// //       setLoading(true);

// //       // ✅ Delete request
// //       const response = await fetch(apiUrl(`/zone/${zoneId}`), {
// //         method: "DELETE",
// //       });

// //       if (!response.ok) {
// //         throw new Error("Failed to delete zone");
// //       }

// //       // ✅ Remove from map
// //       const remainingOverlays = zoneOverlaysRef.current.filter((z) => {
// //         if (z.id === zoneId) {
// //           z.overlay.setMap(null);
// //           return false;
// //         }
// //         return true;
// //       });
// //       zoneOverlaysRef.current = remainingOverlays;

// //       // ✅ Remove from UI
// //       setZones((prev) => prev.filter((z) => z.id !== zoneId));
// //       setZoneVisibility((prev) => {
// //         const newState = { ...prev };
// //         delete newState[zoneId];
// //         return newState;
// //       });

// //       // ✅ Broadcast WebSocket message
// //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// //         wsRef.current.send(
// //           JSON.stringify({
// //             action: "default",
// //             type: "zone-delete",
// //             zoneId, // ✅ correct variable
// //           })
// //         );
// //       }

// //       console.log("✅ Deleted zone:", zoneId);
// //     } catch (err) {
// //       console.error("❌ Delete failed", err);
// //     } finally {
// //       setLoading(false);
// //     }
// //   };

// //   const handleFileUpload = useCallback(
// //     async (event) => {
// //       const files = event.target.files;
// //       if (!files || files.length === 0) return;

// //       setLoading(true);
// //       let successCount = 0;
// //       let errorCount = 0;

// //       for (let file of files) {
// //         try {
// //           const text = await file.text();
// //           const json = JSON.parse(text);

// //           if (
// //             !geojsonValidation.isPolygon(json) &&
// //             !geojsonValidation.isMultiPolygon(json) &&
// //             !geojsonValidation.isLineString(json)
// //           ) {
// //             throw new Error(
// //               "Only Polygon, MultiPolygon, or LineString supported"
// //             );
// //           }

// //           const name =
// //             prompt(`Enter a name for zone in ${file.name}`) ||
// //             file.name.replace(".geojson", "");

// //           if (!name || name.trim() === "") {
// //             throw new Error("Zone name is required");
// //           }

// //           await saveZone(name.trim(), json);
// //           successCount++;
// //         } catch (err) {
// //           console.error(`Error processing ${file.name}:`, err);
// //           errorCount++;
// //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// //         }
// //       }

// //       if (successCount > 0) {
// //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// //       }
// //       if (errorCount > 0) {
// //         toast.error(`Failed to upload ${errorCount} files`);
// //       }

// //       if (fileInputRef.current) {
// //         fileInputRef.current.value = "";
// //       }

// //       setLoading(false);
// //     },
// //     [saveZone]
// //   );

// //   const fetchAllLogs = useCallback(async () => {
// //     try {
// //       const res = await fetch(apiUrl("/logs"));
// //       if (!res.ok) {
// //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// //       }

// //       const data = await res.json();
// //       setAllLogs(
// //         data.sort(
// //           (a, b) =>
// //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// //         )
// //       );
// //     } catch (err) {
// //       console.error("Failed to fetch logs:", err);
// //       toast.error("Failed to fetch logs");
// //     }
// //   }, []);

// //   const toggleZoneVisibility = useCallback((zoneId) => {
// //     setZoneVisibility((prev) => {
// //       const newVisibility = !prev[zoneId];

// //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// //       if (overlayObj && overlayObj.overlay) {
// //         overlayObj.overlay.setMap(
// //           newVisibility ? mapInstanceRef.current : null
// //         );
// //       }

// //       return {
// //         ...prev,
// //         [zoneId]: newVisibility,
// //       };
// //     });
// //   }, []);

// //   // Asset movement and geofencing logic
// //   // Asset movement and geofencing logic
// //   // Disable fake asset movement – now use only WebSocket-driven updates
// //   useEffect(() => {
// //     if (
// //       !mapLoaded ||
// //       !zones.length ||
// //       !mapInstanceRef.current ||
// //       !assetLocation
// //     )
// //       return;

// //     const newPos = {
// //       lat: assetLocation.lat,
// //       lng: assetLocation.lng,
// //     };

// //     const point = turf.point([newPos.lng, newPos.lat]);
// //     let matchedZone = null;

// //     for (let zone of zones) {
// //       if (zone.geojson.type === "Polygon") {
// //         try {
// //           const polygon = turf.polygon(zone.geojson.coordinates);
// //           if (turf.booleanPointInPolygon(point, polygon)) {
// //             matchedZone = zone;
// //             break;
// //           }
// //         } catch (error) {
// //           console.warn("Error checking zone intersection:", error);
// //         }
// //       }
// //     }

// //     const inside = Boolean(matchedZone);
// //     const wasInside = Boolean(lastZoneRef.current);
// //     const ts = new Date().toISOString();

// //     if (inside && !wasInside) {
// //       lastZoneRef.current = matchedZone;
// //       zoneEntryTimeRef.current = ts;
// //       setInZone(true);
// //       setCurrentZone(matchedZone);
// //       setEventLog((prev) => [
// //         { type: "Entered", zone: matchedZone.name, time: ts },
// //         ...prev.slice(0, 9),
// //       ]);
// //       toast.success(`🚧 Entered zone ${matchedZone.name}`);
// //       sendEmailAlert("ENTER", matchedZone, point);
// //       fetchAllLogs();
// //     } else if (!inside && wasInside) {
// //       const exitedZone = lastZoneRef.current;
// //       lastZoneRef.current = null;
// //       setInZone(false);
// //       setCurrentZone(null);

// //       const entryTime = new Date(zoneEntryTimeRef.current).getTime();
// //       const exitTime = new Date(ts).getTime();
// //       const durationMs = exitTime - entryTime;

// //       const minutes = Math.floor(durationMs / 60000);
// //       const seconds = Math.floor((durationMs % 60000) / 1000);
// //       const durationStr = `${minutes}m ${seconds}s`;

// //       setEventLog((prev) => [
// //         {
// //           type: `Exited`,
// //           zone: exitedZone?.name || "Unknown",
// //           time: ts,
// //           duration: `Stayed for ${durationStr}`,
// //         },
// //         ...prev.slice(0, 9),
// //       ]);
// //       toast.success(
// //         `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
// //       );
// //       sendEmailAlert("EXIT", exitedZone || {}, point);
// //       fetchAllLogs();
// //     }

// //     if (!markerRef.current && mapInstanceRef.current) {
// //       markerRef.current = new window.google.maps.Marker({
// //         map: mapInstanceRef.current,
// //         title: "Live Asset Location",
// //         icon: {
// //           url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
// //           scaledSize: new window.google.maps.Size(40, 40),
// //         },
// //       });
// //     }

// //     if (markerRef.current) {
// //       markerRef.current.setIcon({
// //         url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
// //         scaledSize: new window.google.maps.Size(40, 40),
// //       });

// //       markerRef.current.setPosition(
// //         new window.google.maps.LatLng(newPos.lat, newPos.lng)
// //       );
// //     }
// //   }, [mapLoaded, assetLocation, zones, sendEmailAlert, fetchAllLogs]);

// //   // WebSocket connection management
// //   useEffect(() => {
// //     const connectWebSocket = () => {
// //       const socket = new WebSocket(
// //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// //       );

// //       wsRef.current = socket;

// //       socket.onopen = () => {
// //         console.log("✅ WebSocket connected");
// //         setWsStatus("Connected");
// //       };

// //       socket.onclose = () => {
// //         console.warn("🔌 WebSocket disconnected. Reconnecting...");
// //         setWsStatus("Disconnected");
// //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
// //       };

// //       socket.onerror = (err) => {
// //         console.error("❌ WebSocket error", err);
// //         socket.close();
// //       };

// //       socket.onmessage = (event) => {
// //         try {
// //           const data = JSON.parse(event.data);
// //           console.log("📨 WebSocket message received:", data);

// //           // ✅ Log raw lat/lng if present
// //           if (data.lat && data.lng) {
// //             console.log("🛰️ Incoming Location Data →", {
// //               lat: data.lat,
// //               lng: data.lng,
// //               type: data.type,
// //             });
// //           }

// //           // ✅ Match by type
// //           if (data.type === "assetLocationUpdate") {
// //             const { lat, lng } = data.data;

// //             console.log("📍 Updating marker position to →", lat, lng);

// //             setAssetLocation({ lat, lng });

// //             if (!markerRef.current && mapInstanceRef.current) {
// //               console.log("🆕 Creating marker for live asset");
// //               markerRef.current = new window.google.maps.Marker({
// //                 map: mapInstanceRef.current,
// //                 title: "Live Asset Location",
// //                 icon: {
// //                   url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
// //                   scaledSize: new window.google.maps.Size(32, 32),
// //                 },
// //               });
// //             }

// //             if (markerRef.current) {
// //               markerRef.current.setPosition(
// //                 new window.google.maps.LatLng(lat, lng)
// //               );
// //               // mapInstanceRef.current.setCenter({ lat, lng });
// //             } else {
// //               console.warn("❌ Marker is still null");
// //             }
// //           } else {
// //             console.warn("🟡 Unhandled message type or missing `type`:", data);
// //           }
// //         } catch (err) {
// //           console.error("❌ Failed to parse WebSocket message:", err);
// //         }
// //       };
// //     };

// //     connectWebSocket();

// //     return () => {
// //       if (wsRef.current) {
// //         wsRef.current.close();
// //       }
// //       if (reconnectTimeoutRef.current) {
// //         clearTimeout(reconnectTimeoutRef.current);
// //       }
// //     };
// //   }, [loadZones]);

// //   // Load logs on component mount
// //   useEffect(() => {
// //     fetchAllLogs();
// //   }, [fetchAllLogs]);

// //   // Cleanup on unmount
// //   useEffect(() => {
// //     return () => {
// //       clearZoneOverlays();
// //       if (assetMovementIntervalRef.current) {
// //         clearInterval(assetMovementIntervalRef.current);
// //       }
// //     };
// //   }, [clearZoneOverlays]);

// //   const toggleAssetMovement = useCallback(() => {
// //     setAssetMoving((prev) => !prev);
// //   }, []);

// //   const refreshZones = useCallback(() => {
// //     loadZones();
// //   }, [loadZones]);

// //   return (
// //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// //       <Typography variant="h4" gutterBottom>
// //         🗺️ Zone Manager
// //       </Typography>

// //       {/* Status indicators */}
// //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// //         <Chip
// //           label={`WebSocket: ${wsStatus}`}
// //           color={wsStatus === "Connected" ? "success" : "error"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         <Chip
// //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// //           color={assetMoving ? "primary" : "default"}
// //           variant="outlined"
// //           size="small"
// //         />
// //         {currentZone && (
// //           <Chip
// //             label={`In Zone: ${currentZone.name}`}
// //             color="success"
// //             variant="filled"
// //             size="small"
// //           />
// //         )}
// //       </Box>

// //       {/* Loading indicator */}
// //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// //       {/* Map container */}
// //       <Box
// //         ref={mapRef}
// //         sx={{
// //           width: "100%",
// //           height: "500px",
// //           mb: 3,
// //           border: 1,
// //           borderColor: "grey.300",
// //           borderRadius: 1,
// //         }}
// //       />

// //       {/* Asset controls */}
// //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// //         <Button
// //           variant="outlined"
// //           onClick={toggleAssetMovement}
// //           color={assetMoving ? "error" : "success"}
// //         >
// //           {assetMoving ? "Stop Asset" : "Start Asset"}
// //         </Button>
// //         <Button
// //           variant="outlined"
// //           onClick={refreshZones}
// //           startIcon={<RefreshIcon />}
// //         >
// //           Refresh Zones
// //         </Button>
// //       </Box>

// //       {/* File upload section */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             📂 Upload GeoJSON Zone
// //           </Typography>
// //           <input
// //             type="file"
// //             ref={fileInputRef}
// //             accept=".geojson,application/geo+json"
// //             onChange={handleFileUpload}
// //             multiple
// //             disabled={loading}
// //             style={{ marginBottom: "16px" }}
// //           />
// //           {uploadStatus && (
// //             <Alert
// //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// //               sx={{ mt: 1 }}
// //             >
// //               {uploadStatus}
// //             </Alert>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Zones list */}
// //       <Card sx={{ mb: 3 }}>
// //         <CardContent>
// //           <Typography variant="h6" gutterBottom>
// //             🗂️ Saved Zones ({zones.length})
// //           </Typography>

// //           {zones.length === 0 ? (
// //             <Typography color="text.secondary">
// //               No zones available. Draw zones on the map or upload GeoJSON files.
// //             </Typography>
// //           ) : (
// //             <Grid container spacing={2}>
// //               {zones.map((zone) => (
// //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// //                   <Card variant="outlined">
// //                     <CardContent
// //                       sx={{
// //                         display: "flex",
// //                         justifyContent: "space-between",
// //                         alignItems: "center",
// //                       }}
// //                     >
// //                       <Box>
// //                         <Typography variant="subtitle1" gutterBottom>
// //                           {zone.name}
// //                         </Typography>
// //                         <Typography variant="body2" color="text.secondary">
// //                           Type: {zone.geojson.type}
// //                         </Typography>
// //                         {zone.created_at && (
// //                           <Typography variant="caption" color="text.secondary">
// //                             Created:{" "}
// //                             {new Date(zone.created_at).toLocaleDateString()}
// //                           </Typography>
// //                         )}
// //                       </Box>
// //                       <Box>
// //                         <label>
// //                           <input
// //                             type="checkbox"
// //                             checked={zoneVisibility[zone.id] ?? true}
// //                             onChange={() => toggleZoneVisibility(zone.id)}
// //                           />{" "}
// //                           Visible
// //                         </label>
// //                       </Box>
// //                     </CardContent>

// //                     <CardActions>
// //                       <Tooltip title="Delete zone">
// //                         <IconButton
// //                           color="error"
// //                           onClick={() => handleDelete(zone.id)}
// //                           disabled={loading}
// //                         >
// //                           <DeleteIcon />
// //                         </IconButton>
// //                       </Tooltip>
// //                     </CardActions>
// //                   </Card>
// //                 </Grid>
// //               ))}
// //             </Grid>
// //           )}
// //         </CardContent>
// //       </Card>

// //       <Divider sx={{ my: 3 }} />

// //       {/* Event log */}
// //       <Grid container spacing={3}>
// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📋 Recent Events
// //               </Typography>
// //               {eventLog.length === 0 ? (
// //                 <Typography color="text.secondary">
// //                   No recent events.
// //                 </Typography>
// //               ) : (
// //                 <List dense>
// //                   {eventLog.map((event, idx) => (
// //                     <ListItem key={idx}>
// //                       <ListItemText
// //                         primary={`${event.type} - ${event.zone}`}
// //                         secondary={new Date(event.time).toLocaleString()}
// //                       />
// //                     </ListItem>
// //                   ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>

// //         <Grid item xs={12} md={6}>
// //           <Card>
// //             <CardContent>
// //               <Typography variant="h6" gutterBottom>
// //                 📜 Full Log History
// //               </Typography>

// //               {/* Zone Filter Dropdown */}
// //               <Box sx={{ mb: 2 }}>
// //                 <Typography variant="body2" sx={{ mb: 1 }}>
// //                   Filter Logs by Zone:
// //                 </Typography>
// //                 <Select
// //                   size="small"
// //                   value={selectedZoneFilter}
// //                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
// //                   displayEmpty
// //                   sx={{ minWidth: 200 }}
// //                 >
// //                   <MenuItem value="All">All</MenuItem>
// //                   {zones.map((zone) => (
// //                     <MenuItem key={zone.id} value={zone.name}>
// //                       {zone.name}
// //                     </MenuItem>
// //                   ))}
// //                 </Select>
// //               </Box>

// //               {/* Filtered Logs List */}
// //               {allLogs.length === 0 ? (
// //                 <Typography color="text.secondary">No logs found.</Typography>
// //               ) : (
// //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// //                   {allLogs
// //                     .filter(
// //                       (log) =>
// //                         selectedZoneFilter === "All" ||
// //                         log.zoneName === selectedZoneFilter
// //                     )
// //                     .slice(0, 50)
// //                     .map((log, idx) => (
// //                       <ListItem key={log.id || idx}>
// //                         <ListItemText
// //                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// //                           secondary={new Date(log.timestamp).toLocaleString()}
// //                         />
// //                       </ListItem>
// //                     ))}
// //                 </List>
// //               )}
// //             </CardContent>
// //           </Card>
// //         </Grid>
// //       </Grid>

// //       {/* Asset position debug info */}
// //       <Box sx={{ mt: 3 }}>
// //         <Typography variant="caption" color="text.secondary">
// //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// //           {assetPosition.lng.toFixed(6)}
// //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// //         </Typography>
// //       </Box>
// //     </Box>
// //   );
// // };

// // export default ZoneManager;

// // // import React, { useEffect, useRef, useState, useCallback } from "react";
// // // import {
// // //   Box,
// // //   Typography,
// // //   Button,
// // //   Divider,
// // //   List,
// // //   ListItem,
// // //   ListItemText,
// // //   Alert,
// // //   LinearProgress,
// // //   Chip,
// // //   Card,
// // //   CardContent,
// // //   CardActions,
// // //   Grid,
// // //   IconButton,
// // //   Tooltip,
// // //   Select,
// // //   MenuItem,
// // // } from "@mui/material";
// // // import DeleteIcon from "@mui/icons-material/Delete";
// // // import RefreshIcon from "@mui/icons-material/Refresh";
// // // import * as turf from "@turf/turf";
// // // import * as geojsonValidation from "geojson-validation";
// // // import { z } from "zod";
// // // import toast from "react-hot-toast";

// // // // tieminterval calculate
// // // import dayjs from "dayjs";
// // // import duration from "dayjs/plugin/duration";
// // // dayjs.extend(duration);

// // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // // const WS_URL =
// // //   process.env.REACT_APP_WS_URL ||
// // //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // // function apiUrl(path) {
// // //   return `${API_BASE_URL}${path}`;
// // // }

// // // // Enhanced validation schemas
// // // const LatLngSchema = z.object({
// // //   lat: z.number().min(-90).max(90),
// // //   lng: z.number().min(-180).max(180),
// // // });

// // // const ZoneSchema = z.object({
// // //   id: z.string(),
// // //   name: z.string().min(1),
// // //   geojson: z.object({
// // //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// // //     coordinates: z.array(z.any()),
// // //   }),
// // //   created_at: z.string().optional(),
// // // });

// // // const ZoneManager = () => {
// // //   const mapRef = useRef(null);
// // //   const markerRef = useRef(null);
// // //   const mapInstanceRef = useRef(null);
// // //   const fileInputRef = useRef(null);
// // //   const zoneOverlaysRef = useRef([]);
// // //   const lastZoneRef = useRef(null);
// // //   const wsRef = useRef(null);
// // //   const reconnectTimeoutRef = useRef(null);
// // //   const assetMovementIntervalRef = useRef(null);
// // //   const zoneEntryTimeRef = useRef(null); // ⏱️ Replaces setZoneEntryTime

// // //   // State management
// // //   const [mapLoaded, setMapLoaded] = useState(false);
// // //   const [zones, setZones] = useState([]);
// // //   const [uploadStatus, setUploadStatus] = useState("");
// // //   const [loading, setLoading] = useState(false);
// // //   const [wsStatus, setWsStatus] = useState("Disconnected");
// // //   const [assetPosition, setAssetPosition] = useState({
// // //     lat: 40.7825,
// // //     lng: -73.965,
// // //   });
// // //   const [inZone, setInZone] = useState(false);
// // //   const [eventLog, setEventLog] = useState([]);
// // //   const [allLogs, setAllLogs] = useState([]);
// // //   const [currentZone, setCurrentZone] = useState(null);
// // //   const [assetMoving, setAssetMoving] = useState(true);
// // //   const [zoneVisibility, setZoneVisibility] = useState({});
// // //   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");
// // //   const [zoneEntryTime, setZoneEntryTime] = useState(null); // ⏱️ Zone entry timestamp

// // //   // Clear existing zone overlays from map
// // //   const clearZoneOverlays = useCallback(() => {
// // //     zoneOverlaysRef.current.forEach((overlay) => {
// // //       if (overlay && overlay.setMap) {
// // //         overlay.setMap(null);
// // //       }
// // //     });
// // //     zoneOverlaysRef.current = [];
// // //   }, []);

// // //   // Load Google Maps API
// // //   useEffect(() => {
// // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // //       const script = document.createElement("script");
// // //       script.id = "google-maps-script";
// // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // //       script.async = true;
// // //       script.defer = true;
// // //       script.onload = () => setMapLoaded(true);
// // //       script.onerror = () => {
// // //         console.error("Failed to load Google Maps API");
// // //         toast.error("Failed to load Google Maps API");
// // //       };
// // //       document.body.appendChild(script);
// // //     } else if (window.google) {
// // //       setMapLoaded(true);
// // //     }
// // //   }, []);

// // //   // Initialize map when loaded
// // //   useEffect(() => {
// // //     if (mapLoaded && mapRef.current) {
// // //       initMap();
// // //     }
// // //   }, [mapLoaded]);

// // //   const initMap = useCallback(() => {
// // //     if (!mapRef.current || !window.google) return;

// // //     const map = new window.google.maps.Map(mapRef.current, {
// // //       center: { lat: 40.7829, lng: -73.9654 },
// // //       zoom: 15,
// // //       mapTypeControl: true,
// // //       streetViewControl: true,
// // //       fullscreenControl: true,
// // //     });
// // //     mapInstanceRef.current = map;

// // //     // Initialize drawing manager
// // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // //       drawingMode: null,
// // //       drawingControl: true,
// // //       drawingControlOptions: {
// // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // //         drawingModes: [
// // //           window.google.maps.drawing.OverlayType.POLYGON,
// // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // //         ],
// // //       },
// // //       polygonOptions: {
// // //         fillColor: "#2196F3",
// // //         fillOpacity: 0.4,
// // //         strokeWeight: 2,
// // //         strokeColor: "#1976D2",
// // //         clickable: true,
// // //         editable: false,
// // //         zIndex: 1,
// // //       },
// // //       polylineOptions: {
// // //         strokeColor: "#2196F3",
// // //         strokeWeight: 3,
// // //         clickable: true,
// // //         editable: false,
// // //         zIndex: 1,
// // //       },
// // //       rectangleOptions: {
// // //         fillColor: "#2196F3",
// // //         fillOpacity: 0.4,
// // //         strokeWeight: 2,
// // //         strokeColor: "#1976D2",
// // //         clickable: true,
// // //         editable: false,
// // //         zIndex: 1,
// // //       },
// // //       circleOptions: {
// // //         fillColor: "#2196F3",
// // //         fillOpacity: 0.4,
// // //         strokeWeight: 2,
// // //         strokeColor: "#1976D2",
// // //         clickable: true,
// // //         editable: false,
// // //         zIndex: 1,
// // //       },
// // //     });

// // //     drawingManager.setMap(map);

// // //     // Handle drawing completion
// // //     window.google.maps.event.addListener(
// // //       drawingManager,
// // //       "overlaycomplete",
// // //       handleDrawingComplete
// // //     );

// // //     // Load existing zones
// // //     loadZones(map);
// // //   }, []);

// // //   const handleDrawingComplete = useCallback(async (event) => {
// // //     let geojson;
// // //     const name = prompt("Enter Zone Name");

// // //     if (!name || name.trim() === "") {
// // //       alert("Zone name cannot be empty.");
// // //       event.overlay.setMap(null);
// // //       return;
// // //     }

// // //     try {
// // //       switch (event.type) {
// // //         case "polygon": {
// // //           const polygon = event.overlay;
// // //           const path = polygon.getPath().getArray();
// // //           if (path.length < 3) {
// // //             throw new Error("Polygon must have at least 3 points.");
// // //           }
// // //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// // //           coordinates.push(coordinates[0]); // Close polygon

// // //           geojson = {
// // //             type: "Polygon",
// // //             coordinates: [coordinates],
// // //           };
// // //           break;
// // //         }

// // //         case "polyline": {
// // //           const polyline = event.overlay;
// // //           const path = polyline.getPath().getArray();
// // //           if (path.length < 2) {
// // //             throw new Error("Line must have at least 2 points.");
// // //           }
// // //           const coordinates = path.map((latLng) => [
// // //             latLng.lng(),
// // //             latLng.lat(),
// // //           ]);

// // //           geojson = {
// // //             type: "LineString",
// // //             coordinates,
// // //           };
// // //           break;
// // //         }

// // //         case "circle": {
// // //           const circle = event.overlay;
// // //           const center = circle.getCenter();
// // //           const radius = circle.getRadius();

// // //           const points = [];
// // //           const numPoints = 64;
// // //           for (let i = 0; i < numPoints; i++) {
// // //             const angle = (i / numPoints) * 2 * Math.PI;
// // //             const point = turf.destination(
// // //               turf.point([center.lng(), center.lat()]),
// // //               radius / 1000,
// // //               (angle * 180) / Math.PI,
// // //               { units: "kilometers" }
// // //             );
// // //             points.push(point.geometry.coordinates);
// // //           }
// // //           points.push(points[0]);

// // //           geojson = {
// // //             type: "Polygon",
// // //             coordinates: [points],
// // //           };
// // //           break;
// // //         }

// // //         case "rectangle": {
// // //           const rectangle = event.overlay;
// // //           const bounds = rectangle.getBounds();
// // //           const ne = bounds.getNorthEast();
// // //           const sw = bounds.getSouthWest();
// // //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // //           const coordinates = [
// // //             [sw.lng(), sw.lat()],
// // //             [nw.lng(), nw.lat()],
// // //             [ne.lng(), ne.lat()],
// // //             [se.lng(), se.lat()],
// // //             [sw.lng(), sw.lat()],
// // //           ];

// // //           geojson = {
// // //             type: "Polygon",
// // //             coordinates: [coordinates],
// // //           };
// // //           break;
// // //         }

// // //         default:
// // //           throw new Error("Unsupported shape type");
// // //       }

// // //       // Validate GeoJSON
// // //       if (
// // //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// // //         (geojson.type === "LineString" &&
// // //           !geojsonValidation.isLineString(geojson))
// // //       ) {
// // //         throw new Error("Invalid GeoJSON shape. Please try again.");
// // //       }

// // //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // //       event.overlay.setMap(null);

// // //       await saveZone(name.trim(), geojson);
// // //     } catch (error) {
// // //       console.error("Drawing error:", error);
// // //       alert(error.message);
// // //       event.overlay.setMap(null);
// // //     }
// // //   }, []);

// // //   const saveZone = useCallback(async (name, geojson) => {
// // //     setLoading(true);
// // //     try {
// // //       const res = await fetch(apiUrl("/zone"), {
// // //         method: "POST",
// // //         headers: { "Content-Type": "application/json" },
// // //         body: JSON.stringify({ name, geojson }),
// // //       });

// // //       if (!res.ok) {
// // //         const errorData = await res.json().catch(() => ({}));
// // //         throw new Error(
// // //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// // //         );
// // //       }

// // //       const result = await res.json();
// // //       console.log("Zone saved:", name);

// // //       // Broadcast zone update via WebSocket
// // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // //         wsRef.current.send(
// // //           JSON.stringify({
// // //             action: "default",
// // //             type: "zone-update",
// // //             zoneName: name,
// // //             zoneId: result.id,
// // //           })
// // //         );
// // //       }

// // //       toast.success("Zone added successfully!");
// // //       await loadZones(); // Reload zones
// // //     } catch (err) {
// // //       console.error("Failed to save zone:", err);
// // //       toast.error(`Failed to save zone: ${err.message}`);
// // //     } finally {
// // //       setLoading(false);
// // //     }
// // //   }, []);

// // //   const loadZones = useCallback(
// // //     async (mapInstance) => {
// // //       try {
// // //         const res = await fetch(apiUrl("/zones"));
// // //         if (!res.ok) {
// // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // //         }

// // //         const data = await res.json();

// // //         // Validate zones data
// // //         const validatedZones = data.filter((zone) => {
// // //           try {
// // //             ZoneSchema.parse(zone);
// // //             return true;
// // //           } catch (error) {
// // //             console.warn("Invalid zone data:", zone, error);
// // //             return false;
// // //           }
// // //         });

// // //         setZones(validatedZones);

// // //         const map = mapInstance || mapInstanceRef.current;
// // //         if (!map) return;

// // //         // Clear existing zone overlays before adding new ones
// // //         clearZoneOverlays();

// // //         // Add new zone overlays
// // //         validatedZones.forEach((zone) => {
// // //           let overlay;

// // //           if (zone.geojson.type === "Polygon") {
// // //             overlay = new window.google.maps.Polygon({
// // //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // //                 lat,
// // //                 lng,
// // //               })),
// // //               strokeColor: "#FF0000",
// // //               strokeOpacity: 0.8,
// // //               strokeWeight: 2,
// // //               fillColor: "#FF0000",
// // //               fillOpacity: 0.2,
// // //             });
// // //           } else if (zone.geojson.type === "LineString") {
// // //             overlay = new window.google.maps.Polyline({
// // //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // //                 lat,
// // //                 lng,
// // //               })),
// // //               strokeColor: "#FF0000",
// // //               strokeOpacity: 0.8,
// // //               strokeWeight: 3,
// // //             });
// // //           }

// // //           if (overlay) {
// // //             overlay.setMap(map); // Show on map initially

// // //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// // //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// // //             // ✅ Track visibility status
// // //             setZoneVisibility((prev) => ({
// // //               ...prev,
// // //               [zone.id]: true,
// // //             }));

// // //             // Add click listener for zone info
// // //             overlay.addListener("click", () => {
// // //               const infoWindow = new window.google.maps.InfoWindow({
// // //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// // //               });

// // //               const position =
// // //                 overlay.getPath?.().getAt(0) ??
// // //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// // //               if (position) {
// // //                 infoWindow.setPosition(position);
// // //                 infoWindow.open(map);
// // //               }
// // //             });
// // //           }
// // //         });
// // //       } catch (err) {
// // //         console.error("Failed to load zones:", err);
// // //         toast.error("Failed to load zones");
// // //       }
// // //     },
// // //     [clearZoneOverlays]
// // //   );

// // //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// // //     const timestamp = new Date().toISOString();

// // //     const body = {
// // //       type: eventType,
// // //       zoneId: zone.id,
// // //       zoneName: zone.name,
// // //       geojson: zone.geojson,
// // //       point: point.geometry.coordinates,
// // //       timestamp,
// // //     };

// // //     try {
// // //       const res = await fetch(apiUrl("/alert"), {
// // //         method: "POST",
// // //         headers: { "Content-Type": "application/json" },
// // //         body: JSON.stringify(body),
// // //       });

// // //       if (!res.ok) {
// // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // //       }

// // //       console.log("✅ Email alert sent:", body);
// // //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// // //     } catch (err) {
// // //       console.error("❌ Failed to send email alert:", err);
// // //       toast.error("Failed to send alert");
// // //     }
// // //   }, []);

// // //   const logEventToDB = useCallback(
// // //     async (type, zoneName, zoneId, timestamp) => {
// // //       try {
// // //         const res = await fetch(apiUrl("/log-event"), {
// // //           method: "POST",
// // //           headers: { "Content-Type": "application/json" },
// // //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// // //         });

// // //         if (!res.ok) {
// // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // //         }

// // //         console.log("✅ Log saved to DB");
// // //       } catch (err) {
// // //         console.error("❌ Failed to save log to DB:", err);
// // //       }
// // //     },
// // //     []
// // //   );

// // //   const handleDelete = useCallback(async (id) => {
// // //     if (!window.confirm("Are you sure you want to delete this zone?")) return;

// // //     setLoading(true);
// // //     try {
// // //       const res = await fetch(apiUrl(`/zone/${id}`), {
// // //         method: "DELETE",
// // //       });

// // //       if (!res.ok) {
// // //         throw new Error(`Failed to delete zone: ${res.status}`);
// // //       }

// // //       // ✅ Remove from state
// // //       setZones((prev) => prev.filter((zone) => zone.id !== id));

// // //       // ✅ Also remove from map overlays manually
// // //       const newOverlays = zoneOverlaysRef.current.filter((overlay) => {
// // //         const zoneId = overlay.zoneId;
// // //         if (zoneId === id) {
// // //           overlay.setMap(null); // remove from map
// // //           return false; // remove from array
// // //         }
// // //         return true;
// // //       });
// // //       zoneOverlaysRef.current = newOverlays;

// // //       toast.success("Zone deleted successfully");
// // //     } catch (err) {
// // //       console.error("Delete error:", err);
// // //       toast.error(`Error deleting zone`);
// // //     } finally {
// // //       setLoading(false);
// // //     }
// // //   }, []);

// // //   const handleFileUpload = useCallback(
// // //     async (event) => {
// // //       const files = event.target.files;
// // //       if (!files || files.length === 0) return;

// // //       setLoading(true);
// // //       let successCount = 0;
// // //       let errorCount = 0;

// // //       for (let file of files) {
// // //         try {
// // //           const text = await file.text();
// // //           const json = JSON.parse(text);

// // //           if (
// // //             !geojsonValidation.isPolygon(json) &&
// // //             !geojsonValidation.isMultiPolygon(json) &&
// // //             !geojsonValidation.isLineString(json)
// // //           ) {
// // //             throw new Error(
// // //               "Only Polygon, MultiPolygon, or LineString supported"
// // //             );
// // //           }

// // //           const name =
// // //             prompt(`Enter a name for zone in ${file.name}`) ||
// // //             file.name.replace(".geojson", "");

// // //           if (!name || name.trim() === "") {
// // //             throw new Error("Zone name is required");
// // //           }

// // //           await saveZone(name.trim(), json);
// // //           successCount++;
// // //         } catch (err) {
// // //           console.error(`Error processing ${file.name}:`, err);
// // //           errorCount++;
// // //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// // //         }
// // //       }

// // //       if (successCount > 0) {
// // //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// // //       }
// // //       if (errorCount > 0) {
// // //         toast.error(`Failed to upload ${errorCount} files`);
// // //       }

// // //       if (fileInputRef.current) {
// // //         fileInputRef.current.value = "";
// // //       }

// // //       setLoading(false);
// // //     },
// // //     [saveZone]
// // //   );

// // //   const fetchAllLogs = useCallback(async () => {
// // //     try {
// // //       const res = await fetch(apiUrl("/logs"));
// // //       if (!res.ok) {
// // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // //       }

// // //       const data = await res.json();
// // //       setAllLogs(
// // //         data.sort(
// // //           (a, b) =>
// // //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// // //         )
// // //       );
// // //     } catch (err) {
// // //       console.error("Failed to fetch logs:", err);
// // //       toast.error("Failed to fetch logs");
// // //     }
// // //   }, []);

// // //   const toggleZoneVisibility = useCallback((zoneId) => {
// // //     setZoneVisibility((prev) => {
// // //       const newVisibility = !prev[zoneId];

// // //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// // //       if (overlayObj && overlayObj.overlay) {
// // //         overlayObj.overlay.setMap(
// // //           newVisibility ? mapInstanceRef.current : null
// // //         );
// // //       }

// // //       return {
// // //         ...prev,
// // //         [zoneId]: newVisibility,
// // //       };
// // //     });
// // //   }, []);

// // //   // Asset movement and geofencing logic
// // //   useEffect(() => {
// // //     if (
// // //       !mapLoaded ||
// // //       zones.length === 0 ||
// // //       !mapInstanceRef.current ||
// // //       !assetMoving
// // //     )
// // //       return;

// // //     const interval = setInterval(() => {
// // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // //       setAssetPosition((prev) => {
// // //         const newPos = {
// // //           lat: prev.lat + deltaLat,
// // //           lng: prev.lng + deltaLng,
// // //         };

// // //         try {
// // //           LatLngSchema.parse(newPos);
// // //         } catch (err) {
// // //           console.warn("Invalid coordinates, skipping...");
// // //           return prev;
// // //         }

// // //         const point = turf.point([newPos.lng, newPos.lat]);
// // //         let matchedZone = null;

// // //         // Check all zones for intersection
// // //         for (let zone of zones) {
// // //           if (zone.geojson.type === "Polygon") {
// // //             try {
// // //               const polygon = turf.polygon(zone.geojson.coordinates);
// // //               if (turf.booleanPointInPolygon(point, polygon)) {
// // //                 matchedZone = zone;
// // //                 break;
// // //               }
// // //             } catch (error) {
// // //               console.warn("Error checking zone intersection:", error);
// // //             }
// // //           }
// // //         }

// // //         const inside = Boolean(matchedZone);
// // //         const wasInside = Boolean(lastZoneRef.current);

// // //         const ts = new Date().toISOString();

// // //         if (inside && !wasInside) {
// // //           // Entering a zone
// // //           lastZoneRef.current = matchedZone;
// // //           zoneEntryTimeRef.current = ts; // ✅ Use ref instead of setState
// // //           setInZone(true);
// // //           setCurrentZone(matchedZone);

// // //           setEventLog((prev) => [
// // //             { type: "Entered", zone: matchedZone.name, time: ts },
// // //             ...prev.slice(0, 9),
// // //           ]);

// // //           toast.success(`🚧 Entered zone ${matchedZone.name}`);
// // //           sendEmailAlert("ENTER", matchedZone, point);
// // //           fetchAllLogs();
// // //         } else if (!inside && wasInside) {
// // //           // Exiting a zone
// // //           const exitedZone = lastZoneRef.current;
// // //           lastZoneRef.current = null;
// // //           setInZone(false);
// // //           setCurrentZone(null);

// // //           const durationMs = dayjs(ts).diff(dayjs(zoneEntryTimeRef.current));
// // //           const durationStr = dayjs.duration(durationMs).humanize();
// // //           const logMessage = `Stayed for ${durationStr}`;

// // //           setEventLog((prev) => [
// // //             {
// // //               type: `Exited`,
// // //               zone: exitedZone?.name || "Unknown",
// // //               time: ts,
// // //               duration: logMessage,
// // //             },
// // //             ...prev.slice(0, 9),
// // //           ]);

// // //           toast.success(
// // //             `🏁 Exited ${exitedZone?.name || "zone"} after ${durationStr}`
// // //           );
// // //           sendEmailAlert("EXIT", exitedZone || {}, point);
// // //           fetchAllLogs();
// // //         }

// // //         // Update marker
// // //         const map = mapInstanceRef.current;
// // //         if (!markerRef.current && map) {
// // //           markerRef.current = new window.google.maps.Marker({
// // //             map,
// // //             title: "Asset Tracker",
// // //             icon: {
// // //               path: window.google.maps.SymbolPath.CIRCLE,
// // //               scale: 8,
// // //               fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // //               fillOpacity: 1,
// // //               strokeWeight: 2,
// // //               strokeColor: "#FFFFFF",
// // //             },
// // //           });
// // //         }

// // //         if (markerRef.current) {
// // //           markerRef.current.setIcon({
// // //             path: window.google.maps.SymbolPath.CIRCLE,
// // //             scale: 8,
// // //             fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // //             fillOpacity: 1,
// // //             strokeWeight: 2,
// // //             strokeColor: "#FFFFFF",
// // //           });

// // //           markerRef.current.setPosition(
// // //             new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // //           );
// // //         }

// // //         return newPos;
// // //       });
// // //     }, 1000);

// // //     assetMovementIntervalRef.current = interval;
// // //     return () => clearInterval(interval);
// // //   }, [zones, mapLoaded, assetMoving, sendEmailAlert, fetchAllLogs]);

// // //   // WebSocket connection management
// // //   useEffect(() => {
// // //     const connectWebSocket = () => {
// // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // //         return;
// // //       }

// // //       const socket = new WebSocket(
// // //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // //       );
// // //       wsRef.current = socket;

// // //       socket.onopen = () => {
// // //         console.log("✅ WebSocket connected");
// // //         setWsStatus("Connected");
// // //         if (reconnectTimeoutRef.current) {
// // //           clearTimeout(reconnectTimeoutRef.current);
// // //           reconnectTimeoutRef.current = null;
// // //         }
// // //       };

// // //       socket.onclose = () => {
// // //         console.warn("❌ WebSocket disconnected");
// // //         setWsStatus("Disconnected");

// // //         // Attempt to reconnect after 5 seconds
// // //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
// // //       };

// // //       socket.onerror = (err) => {
// // //         console.error("🚨 WebSocket error", err);
// // //         setWsStatus("Error");
// // //       };

// // //       socket.onmessage = (event) => {
// // //         try {
// // //           const data = JSON.parse(event.data);
// // //           console.log("📨 WebSocket message received:", data);

// // //           if (data.type === "zone-update" || data.type === "zone-delete") {
// // //             console.log("🔄 Reloading zones due to update...");
// // //             loadZones();
// // //           }
// // //         } catch (err) {
// // //           console.error("Failed to parse WebSocket message:", err);
// // //         }
// // //       };
// // //     };

// // //     connectWebSocket();

// // //     return () => {
// // //       if (wsRef.current) {
// // //         wsRef.current.close();
// // //       }
// // //       if (reconnectTimeoutRef.current) {
// // //         clearTimeout(reconnectTimeoutRef.current);
// // //       }
// // //     };
// // //   }, [loadZones]);

// // //   // Load logs on component mount
// // //   useEffect(() => {
// // //     fetchAllLogs();
// // //   }, [fetchAllLogs]);

// // //   // Cleanup on unmount
// // //   useEffect(() => {
// // //     return () => {
// // //       clearZoneOverlays();
// // //       if (assetMovementIntervalRef.current) {
// // //         clearInterval(assetMovementIntervalRef.current);
// // //       }
// // //     };
// // //   }, [clearZoneOverlays]);

// // //   const toggleAssetMovement = useCallback(() => {
// // //     setAssetMoving((prev) => !prev);
// // //   }, []);

// // //   const refreshZones = useCallback(() => {
// // //     loadZones();
// // //   }, [loadZones]);

// // //   return (
// // //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// // //       <Typography variant="h4" gutterBottom>
// // //         🗺️ Zone Manager
// // //       </Typography>

// // //       {/* Status indicators */}
// // //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// // //         <Chip
// // //           label={`WebSocket: ${wsStatus}`}
// // //           color={wsStatus === "Connected" ? "success" : "error"}
// // //           variant="outlined"
// // //           size="small"
// // //         />
// // //         <Chip
// // //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// // //           color={assetMoving ? "primary" : "default"}
// // //           variant="outlined"
// // //           size="small"
// // //         />
// // //         {currentZone && (
// // //           <Chip
// // //             label={`In Zone: ${currentZone.name}`}
// // //             color="success"
// // //             variant="filled"
// // //             size="small"
// // //           />
// // //         )}
// // //       </Box>

// // //       {/* Loading indicator */}
// // //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// // //       {/* Map container */}
// // //       <Box
// // //         ref={mapRef}
// // //         sx={{
// // //           width: "100%",
// // //           height: "500px",
// // //           mb: 3,
// // //           border: 1,
// // //           borderColor: "grey.300",
// // //           borderRadius: 1,
// // //         }}
// // //       />

// // //       {/* Asset controls */}
// // //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// // //         <Button
// // //           variant="outlined"
// // //           onClick={toggleAssetMovement}
// // //           color={assetMoving ? "error" : "success"}
// // //         >
// // //           {assetMoving ? "Stop Asset" : "Start Asset"}
// // //         </Button>
// // //         <Button
// // //           variant="outlined"
// // //           onClick={refreshZones}
// // //           startIcon={<RefreshIcon />}
// // //         >
// // //           Refresh Zones
// // //         </Button>
// // //       </Box>

// // //       {/* File upload section */}
// // //       <Card sx={{ mb: 3 }}>
// // //         <CardContent>
// // //           <Typography variant="h6" gutterBottom>
// // //             📂 Upload GeoJSON Zone
// // //           </Typography>
// // //           <input
// // //             type="file"
// // //             ref={fileInputRef}
// // //             accept=".geojson,application/geo+json"
// // //             onChange={handleFileUpload}
// // //             multiple
// // //             disabled={loading}
// // //             style={{ marginBottom: "16px" }}
// // //           />
// // //           {uploadStatus && (
// // //             <Alert
// // //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// // //               sx={{ mt: 1 }}
// // //             >
// // //               {uploadStatus}
// // //             </Alert>
// // //           )}
// // //         </CardContent>
// // //       </Card>

// // //       <Divider sx={{ my: 3 }} />

// // //       {/* Zones list */}
// // //       <Card sx={{ mb: 3 }}>
// // //         <CardContent>
// // //           <Typography variant="h6" gutterBottom>
// // //             🗂️ Saved Zones ({zones.length})
// // //           </Typography>

// // //           {zones.length === 0 ? (
// // //             <Typography color="text.secondary">
// // //               No zones available. Draw zones on the map or upload GeoJSON files.
// // //             </Typography>
// // //           ) : (
// // //             <Grid container spacing={2}>
// // //               {zones.map((zone) => (
// // //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// // //                   <Card variant="outlined">
// // //                     <CardContent
// // //                       sx={{
// // //                         display: "flex",
// // //                         justifyContent: "space-between",
// // //                         alignItems: "center",
// // //                       }}
// // //                     >
// // //                       <Box>
// // //                         <Typography variant="subtitle1" gutterBottom>
// // //                           {zone.name}
// // //                         </Typography>
// // //                         <Typography variant="body2" color="text.secondary">
// // //                           Type: {zone.geojson.type}
// // //                         </Typography>
// // //                         {zone.created_at && (
// // //                           <Typography variant="caption" color="text.secondary">
// // //                             Created:{" "}
// // //                             {new Date(zone.created_at).toLocaleDateString()}
// // //                           </Typography>
// // //                         )}
// // //                       </Box>
// // //                       <Box>
// // //                         <label>
// // //                           <input
// // //                             type="checkbox"
// // //                             checked={zoneVisibility[zone.id] ?? true}
// // //                             onChange={() => toggleZoneVisibility(zone.id)}
// // //                           />{" "}
// // //                           Visible
// // //                         </label>
// // //                       </Box>
// // //                     </CardContent>

// // //                     <CardActions>
// // //                       <Tooltip title="Delete zone">
// // //                         <IconButton
// // //                           color="error"
// // //                           onClick={() => handleDelete(zone.id)}
// // //                           disabled={loading}
// // //                         >
// // //                           <DeleteIcon />
// // //                         </IconButton>
// // //                       </Tooltip>
// // //                     </CardActions>
// // //                   </Card>
// // //                 </Grid>
// // //               ))}
// // //             </Grid>
// // //           )}
// // //         </CardContent>
// // //       </Card>

// // //       <Divider sx={{ my: 3 }} />

// // //       {/* Event log */}
// // //       <Grid container spacing={3}>
// // //         <Grid item xs={12} md={6}>
// // //           <Card>
// // //             <CardContent>
// // //               <Typography variant="h6" gutterBottom>
// // //                 📋 Recent Events
// // //               </Typography>
// // //               {eventLog.length === 0 ? (
// // //                 <Typography color="text.secondary">
// // //                   No recent events.
// // //                 </Typography>
// // //               ) : (
// // //                 <List dense>
// // //                   {eventLog.map((event, idx) => (
// // //                     <ListItem key={idx}>
// // //                       <ListItemText
// // //                         primary={`${event.type} - ${event.zone}`}
// // //                         secondary={new Date(event.time).toLocaleString()}
// // //                       />
// // //                     </ListItem>
// // //                   ))}
// // //                 </List>
// // //               )}
// // //             </CardContent>
// // //           </Card>
// // //         </Grid>

// // //         <Grid item xs={12} md={6}>
// // //           <Card>
// // //             <CardContent>
// // //               <Typography variant="h6" gutterBottom>
// // //                 📜 Full Log History
// // //               </Typography>

// // //               {/* Zone Filter Dropdown */}
// // //               <Box sx={{ mb: 2 }}>
// // //                 <Typography variant="body2" sx={{ mb: 1 }}>
// // //                   Filter Logs by Zone:
// // //                 </Typography>
// // //                 <Select
// // //                   size="small"
// // //                   value={selectedZoneFilter}
// // //                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
// // //                   displayEmpty
// // //                   sx={{ minWidth: 200 }}
// // //                 >
// // //                   <MenuItem value="All">All</MenuItem>
// // //                   {zones.map((zone) => (
// // //                     <MenuItem key={zone.id} value={zone.name}>
// // //                       {zone.name}
// // //                     </MenuItem>
// // //                   ))}
// // //                 </Select>
// // //               </Box>

// // //               {/* Filtered Logs List */}
// // //               {allLogs.length === 0 ? (
// // //                 <Typography color="text.secondary">No logs found.</Typography>
// // //               ) : (
// // //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// // //                   {allLogs
// // //                     .filter(
// // //                       (log) =>
// // //                         selectedZoneFilter === "All" ||
// // //                         log.zoneName === selectedZoneFilter
// // //                     )
// // //                     .slice(0, 50)
// // //                     .map((log, idx) => (
// // //                       <ListItem key={log.id || idx}>
// // //                         <ListItemText
// // //                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// // //                           secondary={new Date(log.timestamp).toLocaleString()}
// // //                         />
// // //                       </ListItem>
// // //                     ))}
// // //                 </List>
// // //               )}
// // //             </CardContent>
// // //           </Card>
// // //         </Grid>
// // //       </Grid>

// // //       {/* Asset position debug info */}
// // //       <Box sx={{ mt: 3 }}>
// // //         <Typography variant="caption" color="text.secondary">
// // //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// // //           {assetPosition.lng.toFixed(6)}
// // //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// // //         </Typography>
// // //       </Box>

// // //       <List dense>
// // //         {eventLog.map((event, idx) => (
// // //           <ListItem key={idx}>
// // //             <ListItemText
// // //               primary={`${event.type} - ${event.zone}`}
// // //               secondary={
// // //                 event.duration
// // //                   ? `${new Date(event.time).toLocaleString()} | ${
// // //                       event.duration
// // //                     }`
// // //                   : new Date(event.time).toLocaleString()
// // //               }
// // //             />
// // //           </ListItem>
// // //         ))}
// // //       </List>
// // //     </Box>
// // //   );
// // // };

// // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState, useCallback } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // //   Alert,
// // // //   LinearProgress,
// // // //   Chip,
// // // //   Card,
// // // //   CardContent,
// // // //   CardActions,
// // // //   Grid,
// // // //   IconButton,
// // // //   Tooltip,
// // // //   Select,
// // // //   MenuItem,
// // // // } from "@mui/material";
// // // // import DeleteIcon from "@mui/icons-material/Delete";
// // // // import RefreshIcon from "@mui/icons-material/Refresh";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // // // const WS_URL =
// // // //   process.env.REACT_APP_WS_URL ||
// // // //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // // Enhanced validation schemas
// // // // const LatLngSchema = z.object({
// // // //   lat: z.number().min(-90).max(90),
// // // //   lng: z.number().min(-180).max(180),
// // // // });

// // // // const ZoneSchema = z.object({
// // // //   id: z.string(),
// // // //   name: z.string().min(1),
// // // //   geojson: z.object({
// // // //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// // // //     coordinates: z.array(z.any()),
// // // //   }),
// // // //   created_at: z.string().optional(),
// // // // });

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]);
// // // //   const lastZoneRef = useRef(null);
// // // //   const wsRef = useRef(null);
// // // //   const reconnectTimeoutRef = useRef(null);
// // // //   const assetMovementIntervalRef = useRef(null);

// // // //   // State management
// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [loading, setLoading] = useState(false);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);
// // // //   const [allLogs, setAllLogs] = useState([]);
// // // //   const [currentZone, setCurrentZone] = useState(null);
// // // //   const [assetMoving, setAssetMoving] = useState(true);
// // // //   const [zoneVisibility, setZoneVisibility] = useState({});
// // // //   const [selectedZoneFilter, setSelectedZoneFilter] = useState("All");

// // // //   // Clear existing zone overlays from map
// // // //   const clearZoneOverlays = useCallback(() => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       if (overlay && overlay.setMap) {
// // // //         overlay.setMap(null);
// // // //       }
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   }, []);

// // // //   // Load Google Maps API
// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       script.onerror = () => {
// // // //         console.error("Failed to load Google Maps API");
// // // //         toast.error("Failed to load Google Maps API");
// // // //       };
// // // //       document.body.appendChild(script);
// // // //     } else if (window.google) {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   // Initialize map when loaded
// // // //   useEffect(() => {
// // // //     if (mapLoaded && mapRef.current) {
// // // //       initMap();
// // // //     }
// // // //   }, [mapLoaded]);

// // // //   const initMap = useCallback(() => {
// // // //     if (!mapRef.current || !window.google) return;

// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //       mapTypeControl: true,
// // // //       streetViewControl: true,
// // // //       fullscreenControl: true,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     // Initialize drawing manager
// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 3,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     // Handle drawing completion
// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       handleDrawingComplete
// // // //     );

// // // //     // Load existing zones
// // // //     loadZones(map);
// // // //   }, []);

// // // //   const handleDrawingComplete = useCallback(async (event) => {
// // // //     let geojson;
// // // //     const name = prompt("Enter Zone Name");

// // // //     if (!name || name.trim() === "") {
// // // //       alert("Zone name cannot be empty.");
// // // //       event.overlay.setMap(null);
// // // //       return;
// // // //     }

// // // //     try {
// // // //       switch (event.type) {
// // // //         case "polygon": {
// // // //           const polygon = event.overlay;
// // // //           const path = polygon.getPath().getArray();
// // // //           if (path.length < 3) {
// // // //             throw new Error("Polygon must have at least 3 points.");
// // // //           }
// // // //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// // // //           coordinates.push(coordinates[0]); // Close polygon

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "polyline": {
// // // //           const polyline = event.overlay;
// // // //           const path = polyline.getPath().getArray();
// // // //           if (path.length < 2) {
// // // //             throw new Error("Line must have at least 2 points.");
// // // //           }
// // // //           const coordinates = path.map((latLng) => [
// // // //             latLng.lng(),
// // // //             latLng.lat(),
// // // //           ]);

// // // //           geojson = {
// // // //             type: "LineString",
// // // //             coordinates,
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "circle": {
// // // //           const circle = event.overlay;
// // // //           const center = circle.getCenter();
// // // //           const radius = circle.getRadius();

// // // //           const points = [];
// // // //           const numPoints = 64;
// // // //           for (let i = 0; i < numPoints; i++) {
// // // //             const angle = (i / numPoints) * 2 * Math.PI;
// // // //             const point = turf.destination(
// // // //               turf.point([center.lng(), center.lat()]),
// // // //               radius / 1000,
// // // //               (angle * 180) / Math.PI,
// // // //               { units: "kilometers" }
// // // //             );
// // // //             points.push(point.geometry.coordinates);
// // // //           }
// // // //           points.push(points[0]);

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [points],
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "rectangle": {
// // // //           const rectangle = event.overlay;
// // // //           const bounds = rectangle.getBounds();
// // // //           const ne = bounds.getNorthEast();
// // // //           const sw = bounds.getSouthWest();
// // // //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //           const coordinates = [
// // // //             [sw.lng(), sw.lat()],
// // // //             [nw.lng(), nw.lat()],
// // // //             [ne.lng(), ne.lat()],
// // // //             [se.lng(), se.lat()],
// // // //             [sw.lng(), sw.lat()],
// // // //           ];

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };
// // // //           break;
// // // //         }

// // // //         default:
// // // //           throw new Error("Unsupported shape type");
// // // //       }

// // // //       // Validate GeoJSON
// // // //       if (
// // // //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// // // //         (geojson.type === "LineString" &&
// // // //           !geojsonValidation.isLineString(geojson))
// // // //       ) {
// // // //         throw new Error("Invalid GeoJSON shape. Please try again.");
// // // //       }

// // // //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //       event.overlay.setMap(null);

// // // //       await saveZone(name.trim(), geojson);
// // // //     } catch (error) {
// // // //       console.error("Drawing error:", error);
// // // //       alert(error.message);
// // // //       event.overlay.setMap(null);
// // // //     }
// // // //   }, []);

// // // //   const saveZone = useCallback(async (name, geojson) => {
// // // //     setLoading(true);
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       if (!res.ok) {
// // // //         const errorData = await res.json().catch(() => ({}));
// // // //         throw new Error(
// // // //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// // // //         );
// // // //       }

// // // //       const result = await res.json();
// // // //       console.log("Zone saved:", name);

// // // //       // Broadcast zone update via WebSocket
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-update",
// // // //             zoneName: name,
// // // //             zoneId: result.id,
// // // //           })
// // // //         );
// // // //       }

// // // //       toast.success("Zone added successfully!");
// // // //       await loadZones(); // Reload zones
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error(`Failed to save zone: ${err.message}`);
// // // //     } finally {
// // // //       setLoading(false);
// // // //     }
// // // //   }, []);

// // // //   const loadZones = useCallback(
// // // //     async (mapInstance) => {
// // // //       try {
// // // //         const res = await fetch(apiUrl("/zones"));
// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         const data = await res.json();

// // // //         // Validate zones data
// // // //         const validatedZones = data.filter((zone) => {
// // // //           try {
// // // //             ZoneSchema.parse(zone);
// // // //             return true;
// // // //           } catch (error) {
// // // //             console.warn("Invalid zone data:", zone, error);
// // // //             return false;
// // // //           }
// // // //         });

// // // //         setZones(validatedZones);

// // // //         const map = mapInstance || mapInstanceRef.current;
// // // //         if (!map) return;

// // // //         // Clear existing zone overlays before adding new ones
// // // //         clearZoneOverlays();

// // // //         // Add new zone overlays
// // // //         validatedZones.forEach((zone) => {
// // // //           let overlay;

// // // //           if (zone.geojson.type === "Polygon") {
// // // //             overlay = new window.google.maps.Polygon({
// // // //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //                 lat,
// // // //                 lng,
// // // //               })),
// // // //               strokeColor: "#FF0000",
// // // //               strokeOpacity: 0.8,
// // // //               strokeWeight: 2,
// // // //               fillColor: "#FF0000",
// // // //               fillOpacity: 0.2,
// // // //             });
// // // //           } else if (zone.geojson.type === "LineString") {
// // // //             overlay = new window.google.maps.Polyline({
// // // //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //                 lat,
// // // //                 lng,
// // // //               })),
// // // //               strokeColor: "#FF0000",
// // // //               strokeOpacity: 0.8,
// // // //               strokeWeight: 3,
// // // //             });
// // // //           }

// // // //           if (overlay) {
// // // //             overlay.setMap(map); // Show on map initially

// // // //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// // // //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// // // //             // ✅ Track visibility status
// // // //             setZoneVisibility((prev) => ({
// // // //               ...prev,
// // // //               [zone.id]: true,
// // // //             }));

// // // //             // Add click listener for zone info
// // // //             overlay.addListener("click", () => {
// // // //               const infoWindow = new window.google.maps.InfoWindow({
// // // //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// // // //               });

// // // //               const position =
// // // //                 overlay.getPath?.().getAt(0) ??
// // // //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// // // //               if (position) {
// // // //                 infoWindow.setPosition(position);
// // // //                 infoWindow.open(map);
// // // //               }
// // // //             });
// // // //           }
// // // //         });
// // // //       } catch (err) {
// // // //         console.error("Failed to load zones:", err);
// // // //         toast.error("Failed to load zones");
// // // //       }
// // // //     },
// // // //     [clearZoneOverlays]
// // // //   );

// // // //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// // // //     const timestamp = new Date().toISOString();

// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point: point.geometry.coordinates,
// // // //       timestamp,
// // // //     };

// // // //     try {
// // // //       const res = await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });

// // // //       if (!res.ok) {
// // // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //       }

// // // //       console.log("✅ Email alert sent:", body);
// // // //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// // // //     } catch (err) {
// // // //       console.error("❌ Failed to send email alert:", err);
// // // //       toast.error("Failed to send alert");
// // // //     }
// // // //   }, []);

// // // //   const logEventToDB = useCallback(
// // // //     async (type, zoneName, zoneId, timestamp) => {
// // // //       try {
// // // //         const res = await fetch(apiUrl("/log-event"), {
// // // //           method: "POST",
// // // //           headers: { "Content-Type": "application/json" },
// // // //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// // // //         });

// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         console.log("✅ Log saved to DB");
// // // //       } catch (err) {
// // // //         console.error("❌ Failed to save log to DB:", err);
// // // //       }
// // // //     },
// // // //     []
// // // //   );

// // // //   const handleDelete = useCallback(
// // // //     async (id) => {
// // // //       if (!window.confirm("Are you sure you want to delete this zone?")) {
// // // //         return;
// // // //       }

// // // //       setLoading(true);
// // // //       try {
// // // //         const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         // WebSocket broadcast
// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-delete",
// // // //               zoneId: id,
// // // //             })
// // // //           );
// // // //         }

// // // //         // Update UI state
// // // //         setZones((prev) => prev.filter((z) => z.id !== id));
// // // //         await loadZones();

// // // //         toast.success("Zone deleted successfully");
// // // //       } catch (err) {
// // // //         console.error("Delete error:", err);
// // // //         toast.error(`Failed to delete zone: ${err.message}`);
// // // //       } finally {
// // // //         setLoading(false);
// // // //       }
// // // //     },
// // // //     [loadZones]
// // // //   );

// // // //   const handleFileUpload = useCallback(
// // // //     async (event) => {
// // // //       const files = event.target.files;
// // // //       if (!files || files.length === 0) return;

// // // //       setLoading(true);
// // // //       let successCount = 0;
// // // //       let errorCount = 0;

// // // //       for (let file of files) {
// // // //         try {
// // // //           const text = await file.text();
// // // //           const json = JSON.parse(text);

// // // //           if (
// // // //             !geojsonValidation.isPolygon(json) &&
// // // //             !geojsonValidation.isMultiPolygon(json) &&
// // // //             !geojsonValidation.isLineString(json)
// // // //           ) {
// // // //             throw new Error(
// // // //               "Only Polygon, MultiPolygon, or LineString supported"
// // // //             );
// // // //           }

// // // //           const name =
// // // //             prompt(`Enter a name for zone in ${file.name}`) ||
// // // //             file.name.replace(".geojson", "");

// // // //           if (!name || name.trim() === "") {
// // // //             throw new Error("Zone name is required");
// // // //           }

// // // //           await saveZone(name.trim(), json);
// // // //           successCount++;
// // // //         } catch (err) {
// // // //           console.error(`Error processing ${file.name}:`, err);
// // // //           errorCount++;
// // // //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// // // //         }
// // // //       }

// // // //       if (successCount > 0) {
// // // //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// // // //       }
// // // //       if (errorCount > 0) {
// // // //         toast.error(`Failed to upload ${errorCount} files`);
// // // //       }

// // // //       if (fileInputRef.current) {
// // // //         fileInputRef.current.value = "";
// // // //       }

// // // //       setLoading(false);
// // // //     },
// // // //     [saveZone]
// // // //   );

// // // //   const fetchAllLogs = useCallback(async () => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/logs"));
// // // //       if (!res.ok) {
// // // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //       }

// // // //       const data = await res.json();
// // // //       setAllLogs(
// // // //         data.sort(
// // // //           (a, b) =>
// // // //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// // // //         )
// // // //       );
// // // //     } catch (err) {
// // // //       console.error("Failed to fetch logs:", err);
// // // //       toast.error("Failed to fetch logs");
// // // //     }
// // // //   }, []);

// // // //   const toggleZoneVisibility = useCallback((zoneId) => {
// // // //     setZoneVisibility((prev) => {
// // // //       const newVisibility = !prev[zoneId];

// // // //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// // // //       if (overlayObj && overlayObj.overlay) {
// // // //         overlayObj.overlay.setMap(
// // // //           newVisibility ? mapInstanceRef.current : null
// // // //         );
// // // //       }

// // // //       return {
// // // //         ...prev,
// // // //         [zoneId]: newVisibility,
// // // //       };
// // // //     });
// // // //   }, []);

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (
// // // //       !mapLoaded ||
// // // //       zones.length === 0 ||
// // // //       !mapInstanceRef.current ||
// // // //       !assetMoving
// // // //     )
// // // //       return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let matchedZone = null;

// // // //         // Check all zones for intersection
// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             try {
// // // //               const polygon = turf.polygon(zone.geojson.coordinates);
// // // //               if (turf.booleanPointInPolygon(point, polygon)) {
// // // //                 matchedZone = zone;
// // // //                 break;
// // // //               }
// // // //             } catch (error) {
// // // //               console.warn("Error checking zone intersection:", error);
// // // //             }
// // // //           }
// // // //         }

// // // //         const inside = Boolean(matchedZone);
// // // //         const wasInside = Boolean(lastZoneRef.current);

// // // //         if (inside && !wasInside) {
// // // //           // Entering a zone

// // // //           lastZoneRef.current = matchedZone;
// // // //           setInZone(true);
// // // //           setCurrentZone(matchedZone);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: ts },
// // // //             ...prev.slice(0, 9), // Keep only last 10 entries
// // // //           ]);
// // // //           toast.success(`🚧 Entered zone: ${matchedZone.name}`, {
// // // //             icon: "📍",
// // // //             duration: 4000,
// // // //           });

// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //           fetchAllLogs();
// // // //         } else if (!inside && wasInside) {
// // // //           // Exiting a zone
// // // //           const exitedZone = lastZoneRef.current;
// // // //           lastZoneRef.current = null;
// // // //           setInZone(false);
// // // //           setCurrentZone(null);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: exitedZone?.name || "Unknown",
// // // //               time: ts,
// // // //             },
// // // //             ...prev.slice(0, 9),
// // // //           ]);
// // // //           toast.error(`🚪 Exited zone: ${exitedZone?.name || "Unknown"}`, {
// // // //             icon: "🚫",
// // // //             duration: 4000,
// // // //           });

// // // //           sendEmailAlert("EXIT", exitedZone || {}, point);
// // // //           fetchAllLogs();
// // // //         }

// // // //         // Update marker
// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current && map) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset Tracker",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 8,
// // // //               fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 2,
// // // //               strokeColor: "#FFFFFF",
// // // //             },
// // // //           });
// // // //         }

// // // //         if (markerRef.current) {
// // // //           markerRef.current.setIcon({
// // // //             path: window.google.maps.SymbolPath.CIRCLE,
// // // //             scale: 8,
// // // //             fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // // //             fillOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             strokeColor: "#FFFFFF",
// // // //           });

// // // //           markerRef.current.setPosition(
// // // //             new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //           );
// // // //         }

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     assetMovementIntervalRef.current = interval;
// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, assetMoving, sendEmailAlert, fetchAllLogs]);

// // // //   // WebSocket connection management
// // // //   useEffect(() => {
// // // //     const connectWebSocket = () => {
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         return;
// // // //       }

// // // //       const socket = new WebSocket(
// // // //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //       );
// // // //       wsRef.current = socket;

// // // //       socket.onopen = () => {
// // // //         console.log("✅ WebSocket connected");
// // // //         setWsStatus("Connected");
// // // //         if (reconnectTimeoutRef.current) {
// // // //           clearTimeout(reconnectTimeoutRef.current);
// // // //           reconnectTimeoutRef.current = null;
// // // //         }
// // // //       };

// // // //       socket.onclose = () => {
// // // //         console.warn("❌ WebSocket disconnected");
// // // //         setWsStatus("Disconnected");

// // // //         // Attempt to reconnect after 5 seconds
// // // //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
// // // //       };

// // // //       socket.onerror = (err) => {
// // // //         console.error("🚨 WebSocket error", err);
// // // //         setWsStatus("Error");
// // // //       };

// // // //       socket.onmessage = (event) => {
// // // //         try {
// // // //           const data = JSON.parse(event.data);
// // // //           console.log("📨 WebSocket message received:", data);

// // // //           if (data.type === "zone-update" || data.type === "zone-delete") {
// // // //             console.log("🔄 Reloading zones due to update...");
// // // //             loadZones();
// // // //           }
// // // //         } catch (err) {
// // // //           console.error("Failed to parse WebSocket message:", err);
// // // //         }
// // // //       };
// // // //     };

// // // //     connectWebSocket();

// // // //     return () => {
// // // //       if (wsRef.current) {
// // // //         wsRef.current.close();
// // // //       }
// // // //       if (reconnectTimeoutRef.current) {
// // // //         clearTimeout(reconnectTimeoutRef.current);
// // // //       }
// // // //     };
// // // //   }, [loadZones]);

// // // //   // Load logs on component mount
// // // //   useEffect(() => {
// // // //     fetchAllLogs();
// // // //   }, [fetchAllLogs]);

// // // //   // Cleanup on unmount
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //       if (assetMovementIntervalRef.current) {
// // // //         clearInterval(assetMovementIntervalRef.current);
// // // //       }
// // // //     };
// // // //   }, [clearZoneOverlays]);

// // // //   const toggleAssetMovement = useCallback(() => {
// // // //     setAssetMoving((prev) => !prev);
// // // //   }, []);

// // // //   const refreshZones = useCallback(() => {
// // // //     loadZones();
// // // //   }, [loadZones]);

// // // //   return (
// // // //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         🗺️ Zone Manager
// // // //       </Typography>

// // // //       {/* Status indicators */}
// // // //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// // // //         <Chip
// // // //           label={`WebSocket: ${wsStatus}`}
// // // //           color={wsStatus === "Connected" ? "success" : "error"}
// // // //           variant="outlined"
// // // //           size="small"
// // // //         />
// // // //         <Chip
// // // //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// // // //           color={assetMoving ? "primary" : "default"}
// // // //           variant="outlined"
// // // //           size="small"
// // // //         />
// // // //         {currentZone && (
// // // //           <Chip
// // // //             label={`In Zone: ${currentZone.name}`}
// // // //             color="success"
// // // //             variant="filled"
// // // //             size="small"
// // // //           />
// // // //         )}
// // // //       </Box>

// // // //       {/* Loading indicator */}
// // // //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// // // //       {/* Map container */}
// // // //       <Box
// // // //         ref={mapRef}
// // // //         sx={{
// // // //           width: "100%",
// // // //           height: "500px",
// // // //           mb: 3,
// // // //           border: 1,
// // // //           borderColor: "grey.300",
// // // //           borderRadius: 1,
// // // //         }}
// // // //       />

// // // //       {/* Asset controls */}
// // // //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// // // //         <Button
// // // //           variant="outlined"
// // // //           onClick={toggleAssetMovement}
// // // //           color={assetMoving ? "error" : "success"}
// // // //         >
// // // //           {assetMoving ? "Stop Asset" : "Start Asset"}
// // // //         </Button>
// // // //         <Button
// // // //           variant="outlined"
// // // //           onClick={refreshZones}
// // // //           startIcon={<RefreshIcon />}
// // // //         >
// // // //           Refresh Zones
// // // //         </Button>
// // // //       </Box>

// // // //       {/* File upload section */}
// // // //       <Card sx={{ mb: 3 }}>
// // // //         <CardContent>
// // // //           <Typography variant="h6" gutterBottom>
// // // //             📂 Upload GeoJSON Zone
// // // //           </Typography>
// // // //           <input
// // // //             type="file"
// // // //             ref={fileInputRef}
// // // //             accept=".geojson,application/geo+json"
// // // //             onChange={handleFileUpload}
// // // //             multiple
// // // //             disabled={loading}
// // // //             style={{ marginBottom: "16px" }}
// // // //           />
// // // //           {uploadStatus && (
// // // //             <Alert
// // // //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// // // //               sx={{ mt: 1 }}
// // // //             >
// // // //               {uploadStatus}
// // // //             </Alert>
// // // //           )}
// // // //         </CardContent>
// // // //       </Card>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       {/* Zones list */}
// // // //       <Card sx={{ mb: 3 }}>
// // // //         <CardContent>
// // // //           <Typography variant="h6" gutterBottom>
// // // //             🗂️ Saved Zones ({zones.length})
// // // //           </Typography>

// // // //           {zones.length === 0 ? (
// // // //             <Typography color="text.secondary">
// // // //               No zones available. Draw zones on the map or upload GeoJSON files.
// // // //             </Typography>
// // // //           ) : (
// // // //             <Grid container spacing={2}>
// // // //               {zones.map((zone) => (
// // // //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// // // //                   <Card variant="outlined">
// // // //                     <CardContent
// // // //                       sx={{
// // // //                         display: "flex",
// // // //                         justifyContent: "space-between",
// // // //                         alignItems: "center",
// // // //                       }}
// // // //                     >
// // // //                       <Box>
// // // //                         <Typography variant="subtitle1" gutterBottom>
// // // //                           {zone.name}
// // // //                         </Typography>
// // // //                         <Typography variant="body2" color="text.secondary">
// // // //                           Type: {zone.geojson.type}
// // // //                         </Typography>
// // // //                         {zone.created_at && (
// // // //                           <Typography variant="caption" color="text.secondary">
// // // //                             Created:{" "}
// // // //                             {new Date(zone.created_at).toLocaleDateString()}
// // // //                           </Typography>
// // // //                         )}
// // // //                       </Box>
// // // //                       <Box>
// // // //                         <label>
// // // //                           <input
// // // //                             type="checkbox"
// // // //                             checked={zoneVisibility[zone.id] ?? true}
// // // //                             onChange={() => toggleZoneVisibility(zone.id)}
// // // //                           />{" "}
// // // //                           Visible
// // // //                         </label>
// // // //                       </Box>
// // // //                     </CardContent>

// // // //                     <CardActions>
// // // //                       <Tooltip title="Delete zone">
// // // //                         <IconButton
// // // //                           color="error"
// // // //                           onClick={() => handleDelete(zone.id)}
// // // //                           disabled={loading}
// // // //                         >
// // // //                           <DeleteIcon />
// // // //                         </IconButton>
// // // //                       </Tooltip>
// // // //                     </CardActions>
// // // //                   </Card>
// // // //                 </Grid>
// // // //               ))}
// // // //             </Grid>
// // // //           )}
// // // //         </CardContent>
// // // //       </Card>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       {/* Event log */}
// // // //       <Grid container spacing={3}>
// // // //         <Grid item xs={12} md={6}>
// // // //           <Card>
// // // //             <CardContent>
// // // //               <Typography variant="h6" gutterBottom>
// // // //                 📋 Recent Events
// // // //               </Typography>
// // // //               {eventLog.length === 0 ? (
// // // //                 <Typography color="text.secondary">
// // // //                   No recent events.
// // // //                 </Typography>
// // // //               ) : (
// // // //                 <List dense>
// // // //                   {eventLog.map((event, idx) => (
// // // //                     <ListItem key={idx}>
// // // //                       <ListItemText
// // // //                         primary={`${event.type} - ${event.zone}`}
// // // //                         secondary={new Date(event.time).toLocaleString()}
// // // //                       />
// // // //                     </ListItem>
// // // //                   ))}
// // // //                 </List>
// // // //               )}
// // // //             </CardContent>
// // // //           </Card>
// // // //         </Grid>

// // // //         <Grid item xs={12} md={6}>
// // // //           <Card>
// // // //             <CardContent>
// // // //               <Typography variant="h6" gutterBottom>
// // // //                 📜 Full Log History
// // // //               </Typography>

// // // //               {/* Zone Filter Dropdown */}
// // // //               <Box sx={{ mb: 2 }}>
// // // //                 <Typography variant="body2" sx={{ mb: 1 }}>
// // // //                   Filter Logs by Zone:
// // // //                 </Typography>
// // // //                 <Select
// // // //                   size="small"
// // // //                   value={selectedZoneFilter}
// // // //                   onChange={(e) => setSelectedZoneFilter(e.target.value)}
// // // //                   displayEmpty
// // // //                   sx={{ minWidth: 200 }}
// // // //                 >
// // // //                   <MenuItem value="All">All</MenuItem>
// // // //                   {zones.map((zone) => (
// // // //                     <MenuItem key={zone.id} value={zone.name}>
// // // //                       {zone.name}
// // // //                     </MenuItem>
// // // //                   ))}
// // // //                 </Select>
// // // //               </Box>

// // // //               {/* Filtered Logs List */}
// // // //               {allLogs.length === 0 ? (
// // // //                 <Typography color="text.secondary">No logs found.</Typography>
// // // //               ) : (
// // // //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// // // //                   {allLogs
// // // //                     .filter(
// // // //                       (log) =>
// // // //                         selectedZoneFilter === "All" ||
// // // //                         log.zoneName === selectedZoneFilter
// // // //                     )
// // // //                     .slice(0, 50)
// // // //                     .map((log, idx) => (
// // // //                       <ListItem key={log.id || idx}>
// // // //                         <ListItemText
// // // //                           primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// // // //                           secondary={new Date(log.timestamp).toLocaleString()}
// // // //                         />
// // // //                       </ListItem>
// // // //                     ))}
// // // //                 </List>
// // // //               )}
// // // //             </CardContent>
// // // //           </Card>
// // // //         </Grid>
// // // //       </Grid>

// // // //       {/* Asset position debug info */}
// // // //       <Box sx={{ mt: 3 }}>
// // // //         <Typography variant="caption" color="text.secondary">
// // // //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// // // //           {assetPosition.lng.toFixed(6)}
// // // //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// // // //         </Typography>
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState, useCallback } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // //   Alert,
// // // //   LinearProgress,
// // // //   Chip,
// // // //   Card,
// // // //   CardContent,
// // // //   CardActions,
// // // //   Grid,
// // // //   IconButton,
// // // //   Tooltip,
// // // // } from "@mui/material";
// // // // import DeleteIcon from "@mui/icons-material/Delete";
// // // // import RefreshIcon from "@mui/icons-material/Refresh";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
// // // // const WS_URL =
// // // //   process.env.REACT_APP_WS_URL ||
// // // //   "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default";

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // // Enhanced validation schemas
// // // // const LatLngSchema = z.object({
// // // //   lat: z.number().min(-90).max(90),
// // // //   lng: z.number().min(-180).max(180),
// // // // });

// // // // const ZoneSchema = z.object({
// // // //   id: z.string(),
// // // //   name: z.string().min(1),
// // // //   geojson: z.object({
// // // //     type: z.enum(["Polygon", "LineString", "MultiPolygon"]),
// // // //     coordinates: z.array(z.any()),
// // // //   }),
// // // //   created_at: z.string().optional(),
// // // // });

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]);
// // // //   const lastZoneRef = useRef(null);
// // // //   const wsRef = useRef(null);
// // // //   const reconnectTimeoutRef = useRef(null);
// // // //   const assetMovementIntervalRef = useRef(null);

// // // //   // State management
// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [loading, setLoading] = useState(false);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);
// // // //   const [allLogs, setAllLogs] = useState([]);
// // // //   const [currentZone, setCurrentZone] = useState(null);
// // // //   const [assetMoving, setAssetMoving] = useState(true);
// // // //   const [zoneVisibility, setZoneVisibility] = useState({});

// // // //   // Clear existing zone overlays from map
// // // //   const clearZoneOverlays = useCallback(() => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       if (overlay && overlay.setMap) {
// // // //         overlay.setMap(null);
// // // //       }
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   }, []);

// // // //   // Load Google Maps API
// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       script.onerror = () => {
// // // //         console.error("Failed to load Google Maps API");
// // // //         toast.error("Failed to load Google Maps API");
// // // //       };
// // // //       document.body.appendChild(script);
// // // //     } else if (window.google) {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   // Initialize map when loaded
// // // //   useEffect(() => {
// // // //     if (mapLoaded && mapRef.current) {
// // // //       initMap();
// // // //     }
// // // //   }, [mapLoaded]);

// // // //   const initMap = useCallback(() => {
// // // //     if (!mapRef.current || !window.google) return;

// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //       mapTypeControl: true,
// // // //       streetViewControl: true,
// // // //       fullscreenControl: true,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     // Initialize drawing manager
// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 3,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         strokeColor: "#1976D2",
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     // Handle drawing completion
// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       handleDrawingComplete
// // // //     );

// // // //     // Load existing zones
// // // //     loadZones(map);
// // // //   }, []);

// // // //   const handleDrawingComplete = useCallback(async (event) => {
// // // //     let geojson;
// // // //     const name = prompt("Enter Zone Name");

// // // //     if (!name || name.trim() === "") {
// // // //       alert("Zone name cannot be empty.");
// // // //       event.overlay.setMap(null);
// // // //       return;
// // // //     }

// // // //     try {
// // // //       switch (event.type) {
// // // //         case "polygon": {
// // // //           const polygon = event.overlay;
// // // //           const path = polygon.getPath().getArray();
// // // //           if (path.length < 3) {
// // // //             throw new Error("Polygon must have at least 3 points.");
// // // //           }
// // // //           let coordinates = path.map((latLng) => [latLng.lng(), latLng.lat()]);
// // // //           coordinates.push(coordinates[0]); // Close polygon

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "polyline": {
// // // //           const polyline = event.overlay;
// // // //           const path = polyline.getPath().getArray();
// // // //           if (path.length < 2) {
// // // //             throw new Error("Line must have at least 2 points.");
// // // //           }
// // // //           const coordinates = path.map((latLng) => [
// // // //             latLng.lng(),
// // // //             latLng.lat(),
// // // //           ]);

// // // //           geojson = {
// // // //             type: "LineString",
// // // //             coordinates,
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "circle": {
// // // //           const circle = event.overlay;
// // // //           const center = circle.getCenter();
// // // //           const radius = circle.getRadius();

// // // //           const points = [];
// // // //           const numPoints = 64;
// // // //           for (let i = 0; i < numPoints; i++) {
// // // //             const angle = (i / numPoints) * 2 * Math.PI;
// // // //             const point = turf.destination(
// // // //               turf.point([center.lng(), center.lat()]),
// // // //               radius / 1000,
// // // //               (angle * 180) / Math.PI,
// // // //               { units: "kilometers" }
// // // //             );
// // // //             points.push(point.geometry.coordinates);
// // // //           }
// // // //           points.push(points[0]);

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [points],
// // // //           };
// // // //           break;
// // // //         }

// // // //         case "rectangle": {
// // // //           const rectangle = event.overlay;
// // // //           const bounds = rectangle.getBounds();
// // // //           const ne = bounds.getNorthEast();
// // // //           const sw = bounds.getSouthWest();
// // // //           const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //           const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //           const coordinates = [
// // // //             [sw.lng(), sw.lat()],
// // // //             [nw.lng(), nw.lat()],
// // // //             [ne.lng(), ne.lat()],
// // // //             [se.lng(), se.lat()],
// // // //             [sw.lng(), sw.lat()],
// // // //           ];

// // // //           geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };
// // // //           break;
// // // //         }

// // // //         default:
// // // //           throw new Error("Unsupported shape type");
// // // //       }

// // // //       // Validate GeoJSON
// // // //       if (
// // // //         (geojson.type === "Polygon" && !geojsonValidation.isPolygon(geojson)) ||
// // // //         (geojson.type === "LineString" &&
// // // //           !geojsonValidation.isLineString(geojson))
// // // //       ) {
// // // //         throw new Error("Invalid GeoJSON shape. Please try again.");
// // // //       }

// // // //       // Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //       event.overlay.setMap(null);

// // // //       await saveZone(name.trim(), geojson);
// // // //     } catch (error) {
// // // //       console.error("Drawing error:", error);
// // // //       alert(error.message);
// // // //       event.overlay.setMap(null);
// // // //     }
// // // //   }, []);

// // // //   const saveZone = useCallback(async (name, geojson) => {
// // // //     setLoading(true);
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       if (!res.ok) {
// // // //         const errorData = await res.json().catch(() => ({}));
// // // //         throw new Error(
// // // //           errorData.error || `HTTP ${res.status}: ${res.statusText}`
// // // //         );
// // // //       }

// // // //       const result = await res.json();
// // // //       console.log("Zone saved:", name);

// // // //       // Broadcast zone update via WebSocket
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-update",
// // // //             zoneName: name,
// // // //             zoneId: result.id,
// // // //           })
// // // //         );
// // // //       }

// // // //       toast.success("Zone added successfully!");
// // // //       await loadZones(); // Reload zones
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error(`Failed to save zone: ${err.message}`);
// // // //     } finally {
// // // //       setLoading(false);
// // // //     }
// // // //   }, []);

// // // //   const loadZones = useCallback(
// // // //     async (mapInstance) => {
// // // //       try {
// // // //         const res = await fetch(apiUrl("/zones"));
// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         const data = await res.json();

// // // //         // Validate zones data
// // // //         const validatedZones = data.filter((zone) => {
// // // //           try {
// // // //             ZoneSchema.parse(zone);
// // // //             return true;
// // // //           } catch (error) {
// // // //             console.warn("Invalid zone data:", zone, error);
// // // //             return false;
// // // //           }
// // // //         });

// // // //         setZones(validatedZones);

// // // //         const map = mapInstance || mapInstanceRef.current;
// // // //         if (!map) return;

// // // //         // Clear existing zone overlays before adding new ones
// // // //         clearZoneOverlays();

// // // //         // Add new zone overlays
// // // //         validatedZones.forEach((zone) => {
// // // //           let overlay;

// // // //           if (zone.geojson.type === "Polygon") {
// // // //             overlay = new window.google.maps.Polygon({
// // // //               paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //                 lat,
// // // //                 lng,
// // // //               })),
// // // //               strokeColor: "#FF0000",
// // // //               strokeOpacity: 0.8,
// // // //               strokeWeight: 2,
// // // //               fillColor: "#FF0000",
// // // //               fillOpacity: 0.2,
// // // //             });
// // // //           } else if (zone.geojson.type === "LineString") {
// // // //             overlay = new window.google.maps.Polyline({
// // // //               path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //                 lat,
// // // //                 lng,
// // // //               })),
// // // //               strokeColor: "#FF0000",
// // // //               strokeOpacity: 0.8,
// // // //               strokeWeight: 3,
// // // //             });
// // // //           }

// // // //           if (overlay) {
// // // //             overlay.setMap(map); // Show on map initially

// // // //             // ✅ Store with ID for future reference (e.g., toggling visibility)
// // // //             zoneOverlaysRef.current.push({ id: zone.id, overlay });

// // // //             // ✅ Track visibility status
// // // //             setZoneVisibility((prev) => ({
// // // //               ...prev,
// // // //               [zone.id]: true,
// // // //             }));

// // // //             // Add click listener for zone info
// // // //             overlay.addListener("click", () => {
// // // //               const infoWindow = new window.google.maps.InfoWindow({
// // // //                 content: `<div><strong>${zone.name}</strong><br>Type: ${zone.geojson.type}</div>`,
// // // //               });

// // // //               const position =
// // // //                 overlay.getPath?.().getAt(0) ??
// // // //                 overlay.getPaths?.().getAt(0)?.getAt(0);

// // // //               if (position) {
// // // //                 infoWindow.setPosition(position);
// // // //                 infoWindow.open(map);
// // // //               }
// // // //             });
// // // //           }
// // // //         });
// // // //       } catch (err) {
// // // //         console.error("Failed to load zones:", err);
// // // //         toast.error("Failed to load zones");
// // // //       }
// // // //     },
// // // //     [clearZoneOverlays]
// // // //   );

// // // //   const sendEmailAlert = useCallback(async (eventType, zone, point) => {
// // // //     const timestamp = new Date().toISOString();

// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point: point.geometry.coordinates,
// // // //       timestamp,
// // // //     };

// // // //     try {
// // // //       const res = await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });

// // // //       if (!res.ok) {
// // // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //       }

// // // //       console.log("✅ Email alert sent:", body);
// // // //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// // // //     } catch (err) {
// // // //       console.error("❌ Failed to send email alert:", err);
// // // //       toast.error("Failed to send alert");
// // // //     }
// // // //   }, []);

// // // //   const logEventToDB = useCallback(
// // // //     async (type, zoneName, zoneId, timestamp) => {
// // // //       try {
// // // //         const res = await fetch(apiUrl("/log-event"), {
// // // //           method: "POST",
// // // //           headers: { "Content-Type": "application/json" },
// // // //           body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// // // //         });

// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         console.log("✅ Log saved to DB");
// // // //       } catch (err) {
// // // //         console.error("❌ Failed to save log to DB:", err);
// // // //       }
// // // //     },
// // // //     []
// // // //   );

// // // //   const handleDelete = useCallback(
// // // //     async (id) => {
// // // //       if (!window.confirm("Are you sure you want to delete this zone?")) {
// // // //         return;
// // // //       }

// // // //       setLoading(true);
// // // //       try {
// // // //         const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //         if (!res.ok) {
// // // //           throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //         }

// // // //         // WebSocket broadcast
// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-delete",
// // // //               zoneId: id,
// // // //             })
// // // //           );
// // // //         }

// // // //         // Update UI state
// // // //         setZones((prev) => prev.filter((z) => z.id !== id));
// // // //         await loadZones();

// // // //         toast.success("Zone deleted successfully");
// // // //       } catch (err) {
// // // //         console.error("Delete error:", err);
// // // //         toast.error(`Failed to delete zone: ${err.message}`);
// // // //       } finally {
// // // //         setLoading(false);
// // // //       }
// // // //     },
// // // //     [loadZones]
// // // //   );

// // // //   const handleFileUpload = useCallback(
// // // //     async (event) => {
// // // //       const files = event.target.files;
// // // //       if (!files || files.length === 0) return;

// // // //       setLoading(true);
// // // //       let successCount = 0;
// // // //       let errorCount = 0;

// // // //       for (let file of files) {
// // // //         try {
// // // //           const text = await file.text();
// // // //           const json = JSON.parse(text);

// // // //           if (
// // // //             !geojsonValidation.isPolygon(json) &&
// // // //             !geojsonValidation.isMultiPolygon(json) &&
// // // //             !geojsonValidation.isLineString(json)
// // // //           ) {
// // // //             throw new Error(
// // // //               "Only Polygon, MultiPolygon, or LineString supported"
// // // //             );
// // // //           }

// // // //           const name =
// // // //             prompt(`Enter a name for zone in ${file.name}`) ||
// // // //             file.name.replace(".geojson", "");

// // // //           if (!name || name.trim() === "") {
// // // //             throw new Error("Zone name is required");
// // // //           }

// // // //           await saveZone(name.trim(), json);
// // // //           successCount++;
// // // //         } catch (err) {
// // // //           console.error(`Error processing ${file.name}:`, err);
// // // //           errorCount++;
// // // //           setUploadStatus(`❌ Error processing ${file.name}: ${err.message}`);
// // // //         }
// // // //       }

// // // //       if (successCount > 0) {
// // // //         setUploadStatus(`✅ Successfully uploaded ${successCount} zones`);
// // // //       }
// // // //       if (errorCount > 0) {
// // // //         toast.error(`Failed to upload ${errorCount} files`);
// // // //       }

// // // //       if (fileInputRef.current) {
// // // //         fileInputRef.current.value = "";
// // // //       }

// // // //       setLoading(false);
// // // //     },
// // // //     [saveZone]
// // // //   );

// // // //   const fetchAllLogs = useCallback(async () => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/logs"));
// // // //       if (!res.ok) {
// // // //         throw new Error(`HTTP ${res.status}: ${res.statusText}`);
// // // //       }

// // // //       const data = await res.json();
// // // //       setAllLogs(
// // // //         data.sort(
// // // //           (a, b) =>
// // // //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// // // //         )
// // // //       );
// // // //     } catch (err) {
// // // //       console.error("Failed to fetch logs:", err);
// // // //       toast.error("Failed to fetch logs");
// // // //     }
// // // //   }, []);

// // // //   const toggleZoneVisibility = useCallback((zoneId) => {
// // // //     setZoneVisibility((prev) => {
// // // //       const newVisibility = !prev[zoneId];

// // // //       const overlayObj = zoneOverlaysRef.current.find((o) => o.id === zoneId);
// // // //       if (overlayObj && overlayObj.overlay) {
// // // //         overlayObj.overlay.setMap(
// // // //           newVisibility ? mapInstanceRef.current : null
// // // //         );
// // // //       }

// // // //       return {
// // // //         ...prev,
// // // //         [zoneId]: newVisibility,
// // // //       };
// // // //     });
// // // //   }, []);

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (
// // // //       !mapLoaded ||
// // // //       zones.length === 0 ||
// // // //       !mapInstanceRef.current ||
// // // //       !assetMoving
// // // //     )
// // // //       return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let matchedZone = null;

// // // //         // Check all zones for intersection
// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             try {
// // // //               const polygon = turf.polygon(zone.geojson.coordinates);
// // // //               if (turf.booleanPointInPolygon(point, polygon)) {
// // // //                 matchedZone = zone;
// // // //                 break;
// // // //               }
// // // //             } catch (error) {
// // // //               console.warn("Error checking zone intersection:", error);
// // // //             }
// // // //           }
// // // //         }

// // // //         const inside = Boolean(matchedZone);
// // // //         const wasInside = Boolean(lastZoneRef.current);

// // // //         if (inside && !wasInside) {
// // // //           // Entering a zone

// // // //           lastZoneRef.current = matchedZone;
// // // //           setInZone(true);
// // // //           setCurrentZone(matchedZone);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: ts },
// // // //             ...prev.slice(0, 9), // Keep only last 10 entries
// // // //           ]);
// // // //           toast.success(`🚧 Entered zone: ${matchedZone.name}`, {
// // // //             icon: "📍",
// // // //             duration: 4000,
// // // //           });

// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //           fetchAllLogs();
// // // //         } else if (!inside && wasInside) {
// // // //           // Exiting a zone
// // // //           const exitedZone = lastZoneRef.current;
// // // //           lastZoneRef.current = null;
// // // //           setInZone(false);
// // // //           setCurrentZone(null);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: exitedZone?.name || "Unknown",
// // // //               time: ts,
// // // //             },
// // // //             ...prev.slice(0, 9),
// // // //           ]);
// // // //           toast.error(`🚪 Exited zone: ${exitedZone?.name || "Unknown"}`, {
// // // //             icon: "🚫",
// // // //             duration: 4000,
// // // //           });

// // // //           sendEmailAlert("EXIT", exitedZone || {}, point);
// // // //           fetchAllLogs();
// // // //         }

// // // //         // Update marker
// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current && map) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset Tracker",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 8,
// // // //               fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 2,
// // // //               strokeColor: "#FFFFFF",
// // // //             },
// // // //           });
// // // //         }

// // // //         if (markerRef.current) {
// // // //           markerRef.current.setIcon({
// // // //             path: window.google.maps.SymbolPath.CIRCLE,
// // // //             scale: 8,
// // // //             fillColor: matchedZone ? "#4CAF50" : "#F44336",
// // // //             fillOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             strokeColor: "#FFFFFF",
// // // //           });

// // // //           markerRef.current.setPosition(
// // // //             new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //           );
// // // //         }

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     assetMovementIntervalRef.current = interval;
// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, assetMoving, sendEmailAlert, fetchAllLogs]);

// // // //   // WebSocket connection management
// // // //   useEffect(() => {
// // // //     const connectWebSocket = () => {
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         return;
// // // //       }

// // // //       const socket = new WebSocket(
// // // //         "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //       );
// // // //       wsRef.current = socket;

// // // //       socket.onopen = () => {
// // // //         console.log("✅ WebSocket connected");
// // // //         setWsStatus("Connected");
// // // //         if (reconnectTimeoutRef.current) {
// // // //           clearTimeout(reconnectTimeoutRef.current);
// // // //           reconnectTimeoutRef.current = null;
// // // //         }
// // // //       };

// // // //       socket.onclose = () => {
// // // //         console.warn("❌ WebSocket disconnected");
// // // //         setWsStatus("Disconnected");

// // // //         // Attempt to reconnect after 5 seconds
// // // //         reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
// // // //       };

// // // //       socket.onerror = (err) => {
// // // //         console.error("🚨 WebSocket error", err);
// // // //         setWsStatus("Error");
// // // //       };

// // // //       socket.onmessage = (event) => {
// // // //         try {
// // // //           const data = JSON.parse(event.data);
// // // //           console.log("📨 WebSocket message received:", data);

// // // //           if (data.type === "zone-update" || data.type === "zone-delete") {
// // // //             console.log("🔄 Reloading zones due to update...");
// // // //             loadZones();
// // // //           }
// // // //         } catch (err) {
// // // //           console.error("Failed to parse WebSocket message:", err);
// // // //         }
// // // //       };
// // // //     };

// // // //     connectWebSocket();

// // // //     return () => {
// // // //       if (wsRef.current) {
// // // //         wsRef.current.close();
// // // //       }
// // // //       if (reconnectTimeoutRef.current) {
// // // //         clearTimeout(reconnectTimeoutRef.current);
// // // //       }
// // // //     };
// // // //   }, [loadZones]);

// // // //   // Load logs on component mount
// // // //   useEffect(() => {
// // // //     fetchAllLogs();
// // // //   }, [fetchAllLogs]);

// // // //   // Cleanup on unmount
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //       if (assetMovementIntervalRef.current) {
// // // //         clearInterval(assetMovementIntervalRef.current);
// // // //       }
// // // //     };
// // // //   }, [clearZoneOverlays]);

// // // //   const toggleAssetMovement = useCallback(() => {
// // // //     setAssetMoving((prev) => !prev);
// // // //   }, []);

// // // //   const refreshZones = useCallback(() => {
// // // //     loadZones();
// // // //   }, [loadZones]);

// // // //   return (
// // // //     <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         🗺️ Zone Manager
// // // //       </Typography>

// // // //       {/* Status indicators */}
// // // //       <Box sx={{ mb: 2, display: "flex", gap: 2, alignItems: "center" }}>
// // // //         <Chip
// // // //           label={`WebSocket: ${wsStatus}`}
// // // //           color={wsStatus === "Connected" ? "success" : "error"}
// // // //           variant="outlined"
// // // //           size="small"
// // // //         />
// // // //         <Chip
// // // //           label={`Asset: ${assetMoving ? "Moving" : "Stopped"}`}
// // // //           color={assetMoving ? "primary" : "default"}
// // // //           variant="outlined"
// // // //           size="small"
// // // //         />
// // // //         {currentZone && (
// // // //           <Chip
// // // //             label={`In Zone: ${currentZone.name}`}
// // // //             color="success"
// // // //             variant="filled"
// // // //             size="small"
// // // //           />
// // // //         )}
// // // //       </Box>

// // // //       {/* Loading indicator */}
// // // //       {loading && <LinearProgress sx={{ mb: 2 }} />}

// // // //       {/* Map container */}
// // // //       <Box
// // // //         ref={mapRef}
// // // //         sx={{
// // // //           width: "100%",
// // // //           height: "500px",
// // // //           mb: 3,
// // // //           border: 1,
// // // //           borderColor: "grey.300",
// // // //           borderRadius: 1,
// // // //         }}
// // // //       />

// // // //       {/* Asset controls */}
// // // //       <Box sx={{ mb: 3, display: "flex", gap: 2 }}>
// // // //         <Button
// // // //           variant="outlined"
// // // //           onClick={toggleAssetMovement}
// // // //           color={assetMoving ? "error" : "success"}
// // // //         >
// // // //           {assetMoving ? "Stop Asset" : "Start Asset"}
// // // //         </Button>
// // // //         <Button
// // // //           variant="outlined"
// // // //           onClick={refreshZones}
// // // //           startIcon={<RefreshIcon />}
// // // //         >
// // // //           Refresh Zones
// // // //         </Button>
// // // //       </Box>

// // // //       {/* File upload section */}
// // // //       <Card sx={{ mb: 3 }}>
// // // //         <CardContent>
// // // //           <Typography variant="h6" gutterBottom>
// // // //             📂 Upload GeoJSON Zone
// // // //           </Typography>
// // // //           <input
// // // //             type="file"
// // // //             ref={fileInputRef}
// // // //             accept=".geojson,application/geo+json"
// // // //             onChange={handleFileUpload}
// // // //             multiple
// // // //             disabled={loading}
// // // //             style={{ marginBottom: "16px" }}
// // // //           />
// // // //           {uploadStatus && (
// // // //             <Alert
// // // //               severity={uploadStatus.startsWith("✅") ? "success" : "error"}
// // // //               sx={{ mt: 1 }}
// // // //             >
// // // //               {uploadStatus}
// // // //             </Alert>
// // // //           )}
// // // //         </CardContent>
// // // //       </Card>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       {/* Zones list */}
// // // //       <Card sx={{ mb: 3 }}>
// // // //         <CardContent>
// // // //           <Typography variant="h6" gutterBottom>
// // // //             🗂️ Saved Zones ({zones.length})
// // // //           </Typography>

// // // //           {zones.length === 0 ? (
// // // //             <Typography color="text.secondary">
// // // //               No zones available. Draw zones on the map or upload GeoJSON files.
// // // //             </Typography>
// // // //           ) : (
// // // //             <Grid container spacing={2}>
// // // //               {zones.map((zone) => (
// // // //                 <Grid item xs={12} sm={6} md={4} key={zone.id}>
// // // //                   <Card variant="outlined">
// // // //                     <CardContent
// // // //                       sx={{
// // // //                         display: "flex",
// // // //                         justifyContent: "space-between",
// // // //                         alignItems: "center",
// // // //                       }}
// // // //                     >
// // // //                       <Box>
// // // //                         <Typography variant="subtitle1" gutterBottom>
// // // //                           {zone.name}
// // // //                         </Typography>
// // // //                         <Typography variant="body2" color="text.secondary">
// // // //                           Type: {zone.geojson.type}
// // // //                         </Typography>
// // // //                         {zone.created_at && (
// // // //                           <Typography variant="caption" color="text.secondary">
// // // //                             Created:{" "}
// // // //                             {new Date(zone.created_at).toLocaleDateString()}
// // // //                           </Typography>
// // // //                         )}
// // // //                       </Box>
// // // //                       <Box>
// // // //                         <label>
// // // //                           <input
// // // //                             type="checkbox"
// // // //                             checked={zoneVisibility[zone.id] ?? true}
// // // //                             onChange={() => toggleZoneVisibility(zone.id)}
// // // //                           />{" "}
// // // //                           Visible
// // // //                         </label>
// // // //                       </Box>
// // // //                     </CardContent>

// // // //                     <CardActions>
// // // //                       <Tooltip title="Delete zone">
// // // //                         <IconButton
// // // //                           color="error"
// // // //                           onClick={() => handleDelete(zone.id)}
// // // //                           disabled={loading}
// // // //                         >
// // // //                           <DeleteIcon />
// // // //                         </IconButton>
// // // //                       </Tooltip>
// // // //                     </CardActions>
// // // //                   </Card>
// // // //                 </Grid>
// // // //               ))}
// // // //             </Grid>
// // // //           )}
// // // //         </CardContent>
// // // //       </Card>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       {/* Event log */}
// // // //       <Grid container spacing={3}>
// // // //         <Grid item xs={12} md={6}>
// // // //           <Card>
// // // //             <CardContent>
// // // //               <Typography variant="h6" gutterBottom>
// // // //                 📋 Recent Events
// // // //               </Typography>
// // // //               {eventLog.length === 0 ? (
// // // //                 <Typography color="text.secondary">
// // // //                   No recent events.
// // // //                 </Typography>
// // // //               ) : (
// // // //                 <List dense>
// // // //                   {eventLog.map((event, idx) => (
// // // //                     <ListItem key={idx}>
// // // //                       <ListItemText
// // // //                         primary={`${event.type} - ${event.zone}`}
// // // //                         secondary={new Date(event.time).toLocaleString()}
// // // //                       />
// // // //                     </ListItem>
// // // //                   ))}
// // // //                 </List>
// // // //               )}
// // // //             </CardContent>
// // // //           </Card>
// // // //         </Grid>

// // // //         <Grid item xs={12} md={6}>
// // // //           <Card>
// // // //             <CardContent>
// // // //               <Typography variant="h6" gutterBottom>
// // // //                 📜 Full Log History
// // // //               </Typography>
// // // //               {allLogs.length === 0 ? (
// // // //                 <Typography color="text.secondary">No logs found.</Typography>
// // // //               ) : (
// // // //                 <List dense sx={{ maxHeight: 400, overflow: "auto" }}>
// // // //                   {allLogs.slice(0, 50).map((log, idx) => (
// // // //                     <ListItem key={log.id || idx}>
// // // //                       <ListItemText
// // // //                         primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// // // //                         secondary={new Date(log.timestamp).toLocaleString()}
// // // //                       />
// // // //                     </ListItem>
// // // //                   ))}
// // // //                 </List>
// // // //               )}
// // // //             </CardContent>
// // // //           </Card>
// // // //         </Grid>
// // // //       </Grid>

// // // //       {/* Asset position debug info */}
// // // //       <Box sx={{ mt: 3 }}>
// // // //         <Typography variant="caption" color="text.secondary">
// // // //           Asset Position: {assetPosition.lat.toFixed(6)},{" "}
// // // //           {assetPosition.lng.toFixed(6)}
// // // //           {inZone && currentZone && ` | Current Zone: ${currentZone.name}`}
// // // //         </Typography>
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]); // ✅ Track zone overlays for cleanup
// // // //   const lastZoneRef = useRef(null);

// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const [allLogs, setAllLogs] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // ✅ Clear existing zone overlays from map
// // // //   const clearZoneOverlays = () => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       overlay.setMap(null);
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000,
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]);

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()],
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         // ✅ Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //         event.overlay.setMap(null);

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();

// // // //       if (res.ok) {
// // // //         console.log("Zone saved:", name);

// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-update",
// // // //               zoneName: name,
// // // //             })
// // // //           );
// // // //         }

// // // //         // ✅ Show toast
// // // //         toast.success("Zone added successfully!");
// // // //       } else {
// // // //         throw new Error(result.error || "Failed to save zone");
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       // ✅ Clear existing zone overlays before adding new ones
// // // //       clearZoneOverlays();

// // // //       // ✅ Add new zone overlays
// // // //       data.forEach((zone) => {
// // // //         let overlay;

// // // //         if (zone.geojson.type === "Polygon") {
// // // //           overlay = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           overlay = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //         }

// // // //         if (overlay) {
// // // //           overlay.setMap(map);
// // // //           zoneOverlaysRef.current.push(overlay); // ✅ Track for cleanup
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const timestamp = new Date().toISOString();

// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp,
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);

// // // //       // Log to DB after sending email
// // // //       await logEventToDB(eventType, zone.name, zone.id, timestamp);
// // // //     } catch (err) {
// // // //       console.error("❌ Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   // 👇 Add this just below sendEmailAlert
// // // //   const logEventToDB = async (type, zoneName, zoneId, timestamp) => {
// // // //     try {
// // // //       await fetch(apiUrl("/log-event"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ type, zoneName, zoneId, timestamp }),
// // // //       });
// // // //       console.log("✅ Log saved to DB");
// // // //     } catch (err) {
// // // //       console.error("❌ Failed to save log to DB:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //       if (!res.ok) throw new Error("Failed to delete");

// // // //       // ✅ WebSocket broadcast
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-delete",
// // // //             zoneId: id,
// // // //           })
// // // //         );
// // // //       }

// // // //       // ✅ Update UI state
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       loadZones();

// // // //       // ✅ Show toast
// // // //       toast.success("✅ Zone deleted successfully");
// // // //     } catch (err) {
// // // //       console.error("❌ Delete error:", err);
// // // //       toast.error("❌ Failed to delete zone");
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     let isMounted = true;
// // // //     const interval = setInterval(() => {
// // // //       if (!isMounted) return;

// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //         }

// // // //         const inside = Boolean(matchedZone);
// // // //         const wasInside = Boolean(lastZoneRef.current);

// // // //         if (inside && !wasInside) {
// // // //           // 👉 Entering a zone
// // // //           lastZoneRef.current = matchedZone;
// // // //           setInZone(true);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: ts },
// // // //             ...prev,
// // // //           ]);

// // // //           sendEmailAlert("ENTER", matchedZone, point); // ✅ Logs also
// // // //           fetchAllLogs();
// // // //         } else if (!inside && wasInside) {
// // // //           // 👉 Exiting a zone
// // // //           const exitedZone = lastZoneRef.current;
// // // //           lastZoneRef.current = null;
// // // //           setInZone(false);
// // // //           const ts = new Date().toISOString();

// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: exitedZone?.name || "Unknown",
// // // //               time: ts,
// // // //             },
// // // //             ...prev,
// // // //           ]);

// // // //           sendEmailAlert("EXIT", exitedZone || {}, point); // ✅ Logs also
// // // //           fetchAllLogs(); //
// // // //         }

// // // //         // ✅ Update marker color
// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: matchedZone ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: matchedZone ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });

// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => {
// // // //       isMounted = false;
// // // //       clearInterval(interval);
// // // //     };
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // ✅ Enhanced WebSocket connection with proper message handling
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // ✅ Handle different message types
// // // //         if (data.type === "zone-update") {
// // // //           console.log("🔄 Reloading zones due to update...");
// // // //           loadZones(); // This will clear and reload all zones
// // // //         } else if (data.type === "zone-delete") {
// // // //           console.log("🗑️ Reloading zones due to deletion...");
// // // //           loadZones(); // Reload zones after deletion
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   const fetchAllLogs = async () => {
// // // //     try {
// // // //       const res = await fetch(`${API_BASE_URL}/logs`);
// // // //       const data = await res.json();
// // // //       setAllLogs(
// // // //         data.sort(
// // // //           (a, b) =>
// // // //             new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
// // // //         )
// // // //       );
// // // //     } catch (err) {
// // // //       console.error("❌ Failed to fetch logs:", err);
// // // //     }
// // // //   };

// // // //   // ✅ Cleanup function to clear overlays when component unmounts
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />
// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>

// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       {/* logs entry exit */}
// // // //       <Box>
// // // //         <Typography variant="h6">📜 Full Log History</Typography>
// // // //         {allLogs.length === 0 ? (
// // // //           <Typography>No logs found.</Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {allLogs.slice(0, 50).map((log, idx) => (
// // // //               <ListItem key={log.id || idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zoneName || "Unknown"}`}
// // // //                   secondary={new Date(log.timestamp).toLocaleString()}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // // import React, { useEffect, useRef, useState } from "react";

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]); // ✅ Track zone overlays for cleanup
// // // //   const lastZoneRef = useRef(null);

// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // ✅ Clear existing zone overlays from map
// // // //   const clearZoneOverlays = () => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       overlay.setMap(null);
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000,
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]);

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()],
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         // ✅ Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //         event.overlay.setMap(null);

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();

// // // //       if (res.ok) {
// // // //         console.log("Zone saved:", name);

// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-update",
// // // //               zoneName: name,
// // // //             })
// // // //           );
// // // //         }

// // // //         // ✅ Show toast
// // // //         toast.success("Zone added successfully!");
// // // //       } else {
// // // //         throw new Error(result.error || "Failed to save zone");
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       // ✅ Clear existing zone overlays before adding new ones
// // // //       clearZoneOverlays();

// // // //       // ✅ Add new zone overlays
// // // //       data.forEach((zone) => {
// // // //         let overlay;

// // // //         if (zone.geojson.type === "Polygon") {
// // // //           overlay = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           overlay = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //         }

// // // //         if (overlay) {
// // // //           overlay.setMap(map);
// // // //           zoneOverlaysRef.current.push(overlay); // ✅ Track for cleanup
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //       if (!res.ok) throw new Error("Failed to delete");

// // // //       // ✅ WebSocket broadcast
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-delete",
// // // //             zoneId: id,
// // // //           })
// // // //         );
// // // //       }

// // // //       // ✅ Update UI state
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       loadZones();

// // // //       // ✅ Show toast
// // // //       toast.success("✅ Zone deleted successfully");
// // // //     } catch (err) {
// // // //       console.error("❌ Delete error:", err);
// // // //       toast.error("❌ Failed to delete zone");
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               inside = true;
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           lastZoneRef.current = matchedZone.name;

// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);

// // // //           const exitedZoneName = lastZoneRef.current || "Unknown";
// // // //           lastZoneRef.current = null;

// // // //           setEventLog((prev) => [
// // // //             { type: "Exited", zone: exitedZoneName, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone, point);
// // // //         }

// // // //         // 🟢 Marker handling
// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // ✅ Enhanced WebSocket connection with proper message handling
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // ✅ Handle different message types
// // // //         if (data.type === "zone-update") {
// // // //           console.log("🔄 Reloading zones due to update...");
// // // //           loadZones(); // This will clear and reload all zones
// // // //         } else if (data.type === "zone-delete") {
// // // //           console.log("🗑️ Reloading zones due to deletion...");
// // // //           loadZones(); // Reload zones after deletion
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   // ✅ Cleanup function to clear overlays when component unmounts
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />
// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>

// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>
// // // //             No events yet. Asset movement will be logged here.
// // // //           </Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.slice(0, 10).map((log, idx) => (
// // // //               <ListItem key={idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zone}`}
// // // //                   secondary={log.time}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]); // ✅ Track zone overlays for cleanup

// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // ✅ Clear existing zone overlays from map
// // // //   const clearZoneOverlays = () => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       overlay.setMap(null);
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000,
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]);

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()],
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         // ✅ Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //         event.overlay.setMap(null);

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();

// // // //       if (res.ok) {
// // // //         console.log("Zone saved:", name);

// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-update",
// // // //               zoneName: name,
// // // //             })
// // // //           );
// // // //         }

// // // //         // ✅ Show toast
// // // //         toast.success("Zone added successfully!");
// // // //       } else {
// // // //         throw new Error(result.error || "Failed to save zone");
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       // ✅ Clear existing zone overlays before adding new ones
// // // //       clearZoneOverlays();

// // // //       // ✅ Add new zone overlays
// // // //       data.forEach((zone) => {
// // // //         let overlay;

// // // //         if (zone.geojson.type === "Polygon") {
// // // //           overlay = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           overlay = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //         }

// // // //         if (overlay) {
// // // //           overlay.setMap(map);
// // // //           zoneOverlaysRef.current.push(overlay); // ✅ Track for cleanup
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //       if (!res.ok) throw new Error("Failed to delete");

// // // //       // ✅ WebSocket broadcast
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-delete",
// // // //             zoneId: id,
// // // //           })
// // // //         );
// // // //       }

// // // //       // ✅ Update UI state
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       loadZones();

// // // //       // ✅ Show toast
// // // //       toast.success("✅ Zone deleted successfully");
// // // //     } catch (err) {
// // // //       console.error("❌ Delete error:", err);
// // // //       toast.error("❌ Failed to delete zone");
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               inside = true;
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // ✅ Enhanced WebSocket connection with proper message handling
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // ✅ Handle different message types
// // // //         if (data.type === "zone-update") {
// // // //           console.log("🔄 Reloading zones due to update...");
// // // //           loadZones(); // This will clear and reload all zones
// // // //         } else if (data.type === "zone-delete") {
// // // //           console.log("🗑️ Reloading zones due to deletion...");
// // // //           loadZones(); // Reload zones after deletion
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   // ✅ Cleanup function to clear overlays when component unmounts
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />
// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>

// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>
// // // //             No events yet. Asset movement will be logged here.
// // // //           </Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.slice(0, 10).map((log, idx) => (
// // // //               <ListItem key={idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zone}`}
// // // //                   secondary={log.time}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]); // ✅ Track zone overlays for cleanup

// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // ✅ Clear existing zone overlays from map
// // // //   const clearZoneOverlays = () => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       overlay.setMap(null);
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000,
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]);

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()],
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         // ✅ Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //         event.overlay.setMap(null);

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();

// // // //       if (res.ok) {
// // // //         console.log("Zone saved:", name);

// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-update",
// // // //               zoneName: name,
// // // //             })
// // // //           );
// // // //         }

// // // //         // ✅ Show toast
// // // //         toast.success("Zone added successfully!");
// // // //       } else {
// // // //         throw new Error(result.error || "Failed to save zone");
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       // ✅ Clear existing zone overlays before adding new ones
// // // //       clearZoneOverlays();

// // // //       // ✅ Add new zone overlays
// // // //       data.forEach((zone) => {
// // // //         let overlay;

// // // //         if (zone.geojson.type === "Polygon") {
// // // //           overlay = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           overlay = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //         }

// // // //         if (overlay) {
// // // //           overlay.setMap(map);
// // // //           zoneOverlaysRef.current.push(overlay); // ✅ Track for cleanup
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //       // ✅ Send WebSocket message for deletion
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-delete",
// // // //             zoneId: id,
// // // //           })
// // // //         );
// // // //       }

// // // //       // ✅ Update local state immediately
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));

// // // //       // ✅ Reload zones to update the map
// // // //       loadZones();

// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               inside = true;
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // ✅ Enhanced WebSocket connection with proper message handling
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // ✅ Handle different message types
// // // //         if (data.type === "zone-update") {
// // // //           console.log("🔄 Reloading zones due to update...");
// // // //           loadZones(); // This will clear and reload all zones
// // // //         } else if (data.type === "zone-delete") {
// // // //           console.log("🗑️ Reloading zones due to deletion...");
// // // //           loadZones(); // Reload zones after deletion
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   // ✅ Cleanup function to clear overlays when component unmounts
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>
// // // //             No events yet. Asset movement will be logged here.
// // // //           </Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.slice(0, 10).map((log, idx) => (
// // // //               <ListItem key={idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zone}`}
// // // //                   secondary={log.time}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);

// // // //   // Fixed WebSocket ref - removed invalid syntax
// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             // Approximate circle as polygon with 64 points
// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const dx = radius * Math.cos(angle);
// // // //               const dy = radius * Math.sin(angle);

// // // //               // Using turf to calculate point at distance and bearing
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000, // convert meters to km
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()], // close polygon
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         // Validate GeoJSON
// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape drawn. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);

// // // //       loadZones();

// // // //       // Broadcast WebSocket message after saving
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "broadcast",
// // // //             type: "zone-update",
// // // //             zoneName: name,
// // // //           })
// // // //         );
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       data.forEach((zone) => {
// // // //         // Handle different geometry types
// // // //         if (zone.geojson.type === "Polygon") {
// // // //           const polygon = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //           polygon.setMap(map);
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           const polyline = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //           polyline.setMap(map);
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               inside = true;
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //           // Note: LineString zones don't have "inside" concept for point-in-polygon
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // WebSocket connection
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://dlo9rcu5g1.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // Handle incoming WebSocket messages
// // // //         if (data.type === "zone-update") {
// // // //           // Reload zones when another client updates them
// // // //           loadZones();
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();

// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>
// // // //             No events yet. Asset movement will be logged here.
// // // //           </Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.slice(0, 10).map((log, idx) => (
// // // //               <ListItem key={idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zone}`}
// // // //                   secondary={log.time}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);

// // // //   // Fixed WebSocket ref - removed invalid syntax
// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null, // default no drawing mode
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             // Approximate circle as polygon with 64 points
// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const dx = radius * Math.cos(angle);
// // // //               const dy = radius * Math.sin(angle);

// // // //               // Using turf or manual calculation to get latLng offset
// // // //               // Using turf (you already imported):
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000, // convert meters to km
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()], // close polygon
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         // Validate polygon or linestring as needed here (you already do for polygon)
// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape drawn. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);

// // // //       loadZones();

// // // //       // ✅ Broadcast WebSocket message after saving
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "broadcast",
// // // //             type: "zone-update",
// // // //             zoneName: name,
// // // //           })
// // // //         );
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;

// // // //       data.forEach((zone) => {
// // // //         const polygon = new window.google.maps.Polygon({
// // // //           paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //             lat,
// // // //             lng,
// // // //           })),
// // // //           strokeColor: "#FF0000",
// // // //           strokeOpacity: 1,
// // // //           strokeWeight: 2,
// // // //           fillColor: "#FF0000",
// // // //           fillOpacity: 0.2,
// // // //         });
// // // //         polygon.setMap(map);
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

  // const sendEmailAlert = async (eventType, zone, point) => {
  //   const body = {
  //     type: eventType,
  //     zoneId: zone.id,
  //     zoneName: zone.name,
  //     geojson: zone.geojson,
  //     point,
  //     timestamp: new Date().toISOString(),
  //   };

  //   try {
  //     await fetch(apiUrl("/alert"), {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify(body),
  //     });
  //     console.log("✅ Email alert sent:", body);
  //   } catch (err) {
  //     console.error("Failed to send email alert:", err);
  //   }
  // };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon or MultiPolygon.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         alert(`✅ Zone uploaded: ${name.trim()}`);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           const polygon = turf.polygon(zone.geojson.coordinates);
// // // //           if (turf.booleanPointInPolygon(point, polygon)) {
// // // //             inside = true;
// // // //             matchedZone = zone;
// // // //             break;
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           ...markerRef.current.getIcon(),
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://dlo9rcu5g1.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //         />

// // // //         <Typography variant="h6">
// // // //           📂{" "}
// // // //           {uploadStatus.startsWith("✅")
// // // //             ? "Upload another GeoJSON Zone"
// // // //             : "Upload GeoJSON Zone"}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>No events yet.</Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.map((log, idx) => (
// // // //               <ListItem key={idx}>
// // // //                 <ListItemText
// // // //                   primary={`${log.time} - ${log.type} - ${log.zone}`}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //       {/* <Typography variant="caption">WebSocket: {wsStatus}</Typography> */}
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null, // default no drawing mode
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             // Approximate circle as polygon with 64 points
// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const dx = radius * Math.cos(angle);
// // // //               const dy = radius * Math.sin(angle);

// // // //               // Using turf or manual calculation to get latLng offset
// // // //               // Using turf (you already imported):
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000, // convert meters to km
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()], // close polygon
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         // Validate polygon or linestring as needed here (you already do for polygon)
// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape drawn. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);
// // // //       loadZones();
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;

// // // //       data.forEach((zone) => {
// // // //         const polygon = new window.google.maps.Polygon({
// // // //           paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //             lat,
// // // //             lng,
// // // //           })),
// // // //           strokeColor: "#FF0000",
// // // //           strokeOpacity: 1,
// // // //           strokeWeight: 2,
// // // //           fillColor: "#FF0000",
// // // //           fillOpacity: 0.2,
// // // //         });
// // // //         polygon.setMap(map);
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon or MultiPolygon.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         alert(`✅ Zone uploaded: ${name.trim()}`);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           const polygon = turf.polygon(zone.geojson.coordinates);
// // // //           if (turf.booleanPointInPolygon(point, polygon)) {
// // // //             inside = true;
// // // //             matchedZone = zone;
// // // //             break;
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           ...markerRef.current.getIcon(),
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //         />

// // // //         <Typography variant="h6">
// // // //           📂{" "}
// // // //           {uploadStatus.startsWith("✅")
// // // //             ? "Upload another GeoJSON Zone"
// // // //             : "Upload GeoJSON Zone"}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>No events yet.</Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.map((log, idx) => (
// // // //               <ListItem key={idx}>
// // // //                 <ListItemText
// // // //                   primary={`${log.time} - ${log.type} - ${log.zone}`}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: window.google.maps.drawing.OverlayType.POLYGON,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [window.google.maps.drawing.OverlayType.POLYGON],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         if (event.type === "polygon") {
// // // //           const polygon = event.overlay;
// // // //           const path = polygon.getPath().getArray();
// // // //           const coordinates = path.map((latLng) => [
// // // //             latLng.lng(),
// // // //             latLng.lat(),
// // // //           ]);

// // // //           if (coordinates.length < 3) {
// // // //             alert("Polygon must have at least 3 points.");
// // // //             polygon.setMap(null);
// // // //             return;
// // // //           }

// // // //           const name = prompt("Enter Zone Name");
// // // //           if (!name || name.trim() === "") {
// // // //             alert("Zone name cannot be empty.");
// // // //             polygon.setMap(null);
// // // //             return;
// // // //           }

// // // //           coordinates.push(coordinates[0]); // close polygon

// // // //           const geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };

// // // //           if (!geojsonValidation.isPolygon(geojson)) {
// // // //             alert("Invalid Polygon drawn. Please try again.");
// // // //             polygon.setMap(null);
// // // //             return;
// // // //           }

// // // //           await saveZone(name.trim(), geojson);
// // // //         }
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);
// // // //       loadZones();
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;

// // // //       data.forEach((zone) => {
// // // //         const polygon = new window.google.maps.Polygon({
// // // //           paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //             lat,
// // // //             lng,
// // // //           })),
// // // //           strokeColor: "#FF0000",
// // // //           strokeOpacity: 1,
// // // //           strokeWeight: 2,
// // // //           fillColor: "#FF0000",
// // // //           fillOpacity: 0.2,
// // // //         });
// // // //         polygon.setMap(map);
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon or MultiPolygon.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         alert(`✅ Zone uploaded: ${name.trim()}`);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           const polygon = turf.polygon(zone.geojson.coordinates);
// // // //           if (turf.booleanPointInPolygon(point, polygon)) {
// // // //             inside = true;
// // // //             matchedZone = zone;
// // // //             break;
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           ...markerRef.current.getIcon(),
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 5000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //         />

// // // //         <Typography variant="h6">
// // // //           📂{" "}
// // // //           {uploadStatus.startsWith("✅")
// // // //             ? "Upload another GeoJSON Zone"
// // // //             : "Upload GeoJSON Zone"}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>No events yet.</Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.map((log, idx) => (
// // // //               <ListItem key={idx}>
// // // //                 <ListItemText
// // // //                   primary={`${log.time} - ${log.type} - ${log.zone}`}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Input,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const ZONE_API = "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone";
// // // // const ZONES_API =
// // // //   "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zones";
// // // // const DELETE_ZONE_API = (id) =>
// // // //   `https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone/${id}`;
// // // // const EMAIL_ALERT_API =
// // // //   "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/alert";

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);

// // // //   //    file uplod
// // // //   const fileInputRef = useRef(null);

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   // Schema
// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // Load Google Maps JS API
// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: window.google.maps.drawing.OverlayType.POLYGON,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [window.google.maps.drawing.OverlayType.POLYGON],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         if (event.type === "polygon") {
// // // //           const polygon = event.overlay;
// // // //           const path = polygon.getPath().getArray();
// // // //           const coordinates = path.map((latLng) => [
// // // //             latLng.lng(),
// // // //             latLng.lat(),
// // // //           ]);

// // // //           if (coordinates.length < 3) {
// // // //             alert("Polygon must have at least 3 points.");
// // // //             polygon.setMap(null); // ❌ Remove invalid polygon
// // // //             return;
// // // //           }

// // // //           const name = prompt("Enter Zone Name");
// // // //           if (!name || name.trim() === "") {
// // // //             alert("Zone name cannot be empty.");
// // // //             polygon.setMap(null); // ❌ Remove polygon if name is invalid
// // // //             return;
// // // //           }

// // // //           coordinates.push(coordinates[0]); // Close the polygon loop

// // // //           const geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };

// // // //           if (!geojsonValidation.isPolygon(geojson)) {
// // // //             alert("Invalid Polygon drawn. Please try again.");
// // // //             polygon.setMap(null); // ❌ Remove invalid geometry
// // // //             return;
// // // //           }

// // // //           await saveZone(name.trim(), geojson);
// // // //         }
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(ZONE_API, {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);
// // // //       loadZones();
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(ZONES_API);
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;

// // // //       data.forEach((zone) => {
// // // //         const polygon = new window.google.maps.Polygon({
// // // //           paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //             lat,
// // // //             lng,
// // // //           })),
// // // //           strokeColor: "#FF0000",
// // // //           strokeOpacity: 1,
// // // //           strokeWeight: 2,
// // // //           fillColor: "#FF0000",
// // // //           fillOpacity: 0.2,
// // // //         });
// // // //         polygon.setMap(map);
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(EMAIL_ALERT_API, {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(DELETE_ZONE_API(id), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon or MultiPolygon.`
// // // //           );
// // // //           continue; // skip invalid file
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue; // skip files without a name
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         alert(`✅ Zone uploaded: ${name.trim()}`);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     // Clear input after all files processed
// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           const polygon = turf.polygon(zone.geojson.coordinates);
// // // //           if (turf.booleanPointInPolygon(point, polygon)) {
// // // //             inside = true;
// // // //             matchedZone = zone;
// // // //             break;
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);
// // // //           setEventLog((prev) => [
// // // //             {
// // // //               type: "Exited",
// // // //               zone: matchedZone?.name || "Unknown",
// // // //               time: timestamp,
// // // //             },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone || {}, point);
// // // //         }

// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inZone ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           ...markerRef.current.getIcon(),
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 5000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //   type="file"
// // // //   ref={fileInputRef}
// // // //   accept=".geojson,application/geo+json"
// // // //   onChange={handleFileUpload}
// // // //   multiple
// // // // />

// // // //         <Typography variant="h6">
// // // //           📂{" "}
// // // //           {uploadStatus.startsWith("✅")
// // // //             ? "Upload another GeoJSON Zone"
// // // //             : "Upload GeoJSON Zone"}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones</Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>No events yet.</Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.map((log, idx) => (
// // // //               <ListItem key={idx}>
// // // //                 <ListItemText
// // // //                   primary={`${log.time} - ${log.type} - ${log.zone}`}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import { Box, Typography, Input, Button, Divider } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const ZONE_API = "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone";
// // // // const ZONES_API =
// // // //   "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zones";
// // // // const DELETE_ZONE_API = (id) =>
// // // //   `https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone/${id}`;

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);

// // // //   // Load Google Maps JS API
// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: window.google.maps.drawing.OverlayType.POLYGON,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [window.google.maps.drawing.OverlayType.POLYGON],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         if (event.type === "polygon") {
// // // //           const polygon = event.overlay;
// // // //           const coordinates = polygon
// // // //             .getPath()
// // // //             .getArray()
// // // //             .map((latLng) => [latLng.lng(), latLng.lat()]);
// // // //           coordinates.push(coordinates[0]); // close the polygon

// // // //           const geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };

// // // //           const name = prompt("Enter Zone Name") || "Unnamed Zone";
// // // //           await saveZone(name, geojson);
// // // //         }
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(ZONE_API, {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });
// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);
// // // //       loadZones(); // Refresh map with new zone
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(ZONES_API);
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;

// // // //       data.forEach((zone) => {
// // // //         const polygon = new window.google.maps.Polygon({
// // // //           paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //             lat,
// // // //             lng,
// // // //           })),
// // // //           strokeColor: "#FF0000",
// // // //           strokeOpacity: 1,
// // // //           strokeWeight: 2,
// // // //           fillColor: "#FF0000",
// // // //           fillOpacity: 0.2,
// // // //         });
// // // //         polygon.setMap(map);
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(DELETE_ZONE_API(id), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       alert("Zone deleted");
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const file = event.target.files?.[0];
// // // //     if (!file) return;

// // // //     try {
// // // //       const text = await file.text();
// // // //       const json = JSON.parse(text);

// // // //       if (
// // // //         !geojsonValidation.isPolygon(json) &&
// // // //         !geojsonValidation.isMultiPolygon(json)
// // // //       ) {
// // // //         setUploadStatus("❌ Invalid GeoJSON: Only Polygon or MultiPolygon.");
// // // //         return;
// // // //       }

// // // //       const name =
// // // //         prompt("Enter a name for this zone") ||
// // // //         file.name.replace(".geojson", "");
// // // //       await saveZone(name, json);
// // // //       setUploadStatus(`✅ Zone uploaded: ${name}`);
// // // //     } catch (err) {
// // // //       console.error(err);
// // // //       setUploadStatus("❌ Error reading file or uploading.");
// // // //     }
// // // //   };

// // // //   // 🚀 Simulate asset movement + geofence check
// // // //   // Helper to send alert email via backend
// // // //   const sendAlertEmail = async (subject, message) => {
// // // //     try {
// // // //       const res = await fetch(
// // // //         "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/alert",
// // // //         {
// // // //           method: "POST",
// // // //           headers: { "Content-Type": "application/json" },
// // // //           body: JSON.stringify({ subject, message }),
// // // //         }
// // // //       );

// // // //       if (res.ok) {
// // // //         console.log("✅ Email sent successfully");
// // // //       } else {
// // // //         const data = await res.json();
// // // //         console.error("❌ Email failed:", data);
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("❌ Error sending email:", err);
// // // //     }
// // // //   };

// // // //   // Inside useEffect() that simulates GPS
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;

// // // //         for (let zone of zones) {
// // // //           const polygon = turf.polygon(zone.geojson.coordinates);
// // // //           if (turf.booleanPointInPolygon(point, polygon)) {
// // // //             inside = true;
// // // //             break;
// // // //           }
// // // //         }

// // // //         const map = mapInstanceRef.current;

// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: "#00f",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         if (inside && !inZone) {
// // // //           const msg = `🚀 Asset ENTERED a geofence at (${newPos.lat}, ${newPos.lng})`;
// // // //           console.log(msg);
// // // //           sendAlertEmail("🚀 Asset ENTERED Zone", msg);
// // // //           setInZone(true);
// // // //         } else if (!inside && inZone) {
// // // //           const msg = `🏃‍♂️ Asset EXITED the geofence at (${newPos.lat}, ${newPos.lng})`;
// // // //           console.log(msg);
// // // //           sendAlertEmail("🏃‍♂️ Asset EXITED Zone", msg);
// // // //           setInZone(false);
// // // //         }

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <Input
// // // //           type="file"
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //         />
// // // //         {uploadStatus && <Typography mt={1}>{uploadStatus}</Typography>}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6" gutterBottom>
// // // //           🗂️ Saved Zones
// // // //         </Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // // ZoneManager.js
// // // // import React, { useEffect, useRef, useState } from "react";
// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Input,
// // // //   Button,
// // // //   Divider,
// // // //   CircularProgress,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const ZONE_API = "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone";
// // // // const ZONES_API =
// // // //   "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zones";
// // // // const DELETE_ZONE_API = (id) =>
// // // //   `https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone/${id}`;

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");

// // // //   // Load Google Maps API script
// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => {
// // // //         setMapLoaded(true);
// // // //       };
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: window.google.maps.drawing.OverlayType.POLYGON,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [window.google.maps.drawing.OverlayType.POLYGON],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         if (event.type === "polygon") {
// // // //           const polygon = event.overlay;

// // // //           const coordinates = polygon
// // // //             .getPath()
// // // //             .getArray()
// // // //             .map((latLng) => [latLng.lng(), latLng.lat()]);

// // // //           coordinates.push(coordinates[0]); // close the polygon

// // // //           const geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };

// // // //           const name = prompt("Enter Zone Name") || "Unnamed Zone";

// // // //           await saveZone(name, geojson);
// // // //         }
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(ZONE_API, {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();
// // // //       alert("Zone saved: " + name);
// // // //       loadZones(); // Refresh after save
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       alert("Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(ZONES_API);
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       if (mapInstance || mapRef.current) {
// // // //         const map =
// // // //           mapInstance || new window.google.maps.Map(mapRef.current, {});
// // // //         data.forEach((zone) => {
// // // //           const polygon = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //           polygon.setMap(map);
// // // //         });
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       await fetch(DELETE_ZONE_API(id), { method: "DELETE" });
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //     } catch (err) {
// // // //       console.error("Failed to delete zone:", err);
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const file = event.target.files?.[0];
// // // //     if (!file) return;

// // // //     try {
// // // //       const text = await file.text();
// // // //       const json = JSON.parse(text);

// // // //       if (
// // // //         !geojsonValidation.isPolygon(json) &&
// // // //         !geojsonValidation.isMultiPolygon(json)
// // // //       ) {
// // // //         setUploadStatus("❌ Invalid GeoJSON: Only Polygon or MultiPolygon.");
// // // //         return;
// // // //       }

// // // //       const name =
// // // //         prompt("Enter a name for this zone") ||
// // // //         file.name.replace(".geojson", "");

// // // //       await saveZone(name, json);
// // // //       setUploadStatus(`✅ Zone uploaded: ${name}`);
// // // //     } catch (err) {
// // // //       console.error(err);
// // // //       setUploadStatus("❌ Error reading file or uploading.");
// // // //     }
// // // //   };

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <Input
// // // //           type="file"
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //         />
// // // //         {uploadStatus && <Typography mt={1}>{uploadStatus}</Typography>}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6" gutterBottom>
// // // //           🗂️ Saved Zones
// // // //         </Typography>
// // // //         {zones.length === 0 ? (
// // // //           <Typography>No zones available.</Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box key={zone.id} sx={{ mb: 1 }}>
// // // //               <Typography>{zone.name}</Typography>
// // // //               <Button
// // // //                 variant="outlined"
// // // //                 color="error"
// // // //                 onClick={() => handleDelete(zone.id)}
// // // //               >
// // // //                 Delete Zone
// // // //               </Button>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // import React, { useEffect, useRef, useState } from "react";

// // // // // const GOOGLE_MAP_API_KEY = "REACT_APP_GOOGLEAPI"; // 🔐 Replace with your key
// // // // const ZONE_API_URL =
// // // //   "https://pzp4rxjond.execute-api.us-east-1.amazonaws.com/zone";

// // // // const MapWithDraw = () => {
// // // //   const mapRef = useRef(null);
// // // //   const [mapLoaded, setMapLoaded] = useState(false);

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.REACT_APP_GOOGLEAPI}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => {
// // // //         window.initMap = initMap;
// // // //         setMapLoaded(true);
// // // //       };
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   const initMap = () => {
// // // //     if (!mapRef.current) return;

// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 }, // Central Park default
// // // //       zoom: 15,
// // // //     });

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: window.google.maps.drawing.OverlayType.POLYGON,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [window.google.maps.drawing.OverlayType.POLYGON],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         if (event.type === "polygon") {
// // // //           const polygon = event.overlay;

// // // //           const coordinates = polygon
// // // //             .getPath()
// // // //             .getArray()
// // // //             .map((latLng) => [latLng.lng(), latLng.lat()]); // [lng, lat] order for GeoJSON

// // // //           coordinates.push(coordinates[0]); // close the polygon

// // // //           const geojson = {
// // // //             type: "Polygon",
// // // //             coordinates: [coordinates],
// // // //           };

// // // //           const zoneData = {
// // // //             name: prompt("Enter Zone Name") || "Unnamed Zone",
// // // //             geojson,
// // // //           };

// // // //           try {
// // // //             const res = await fetch(ZONE_API_URL, {
// // // //               method: "POST",
// // // //               headers: {
// // // //                 "Content-Type": "application/json",
// // // //               },
// // // //               body: JSON.stringify(zoneData),
// // // //             });

// // // //             const result = await res.json();
// // // //             alert("Zone saved: " + JSON.stringify(result));
// // // //           } catch (err) {
// // // //             alert("Failed to save zone");
// // // //             console.error(err);
// // // //           }
// // // //         }
// // // //       }
// // // //     );
// // // //   };

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   return <div ref={mapRef} style={{ width: "100%", height: "600px" }} />;
// // // // };

// // // // export default MapWithDraw;

// // // // import {
// // // //   Box,
// // // //   Typography,
// // // //   Button,
// // // //   Divider,
// // // //   List,
// // // //   ListItem,
// // // //   ListItemText,
// // // // } from "@mui/material";
// // // // import * as turf from "@turf/turf";
// // // // import * as geojsonValidation from "geojson-validation";
// // // // import { z } from "zod";
// // // // import toast from "react-hot-toast";

// // // // const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
// // // // const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;

// // // // function apiUrl(path) {
// // // //   return `${API_BASE_URL}${path}`;
// // // // }

// // // // const ZoneManager = () => {
// // // //   const mapRef = useRef(null);
// // // //   const markerRef = useRef(null);
// // // //   const mapInstanceRef = useRef(null);
// // // //   const fileInputRef = useRef(null);
// // // //   const zoneOverlaysRef = useRef([]); // ✅ Track zone overlays for cleanup
// // // //   const lastZoneRef = useRef(null);

// // // //   const wsRef = useRef(null);
// // // //   const [wsStatus, setWsStatus] = useState("Disconnected");

// // // //   const [mapLoaded, setMapLoaded] = useState(false);
// // // //   const [zones, setZones] = useState([]);
// // // //   const [uploadStatus, setUploadStatus] = useState("");
// // // //   const [assetPosition, setAssetPosition] = useState({
// // // //     lat: 40.7825,
// // // //     lng: -73.965,
// // // //   });
// // // //   const [inZone, setInZone] = useState(false);
// // // //   const [eventLog, setEventLog] = useState([]);

// // // //   const LatLngSchema = z.object({
// // // //     lat: z.number().min(-90).max(90),
// // // //     lng: z.number().min(-180).max(180),
// // // //   });

// // // //   // ✅ Clear existing zone overlays from map
// // // //   const clearZoneOverlays = () => {
// // // //     zoneOverlaysRef.current.forEach((overlay) => {
// // // //       overlay.setMap(null);
// // // //     });
// // // //     zoneOverlaysRef.current = [];
// // // //   };

// // // //   useEffect(() => {
// // // //     if (!window.google && !document.getElementById("google-maps-script")) {
// // // //       const script = document.createElement("script");
// // // //       script.id = "google-maps-script";
// // // //       script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAP_API_KEY}&libraries=drawing`;
// // // //       script.async = true;
// // // //       script.defer = true;
// // // //       script.onload = () => setMapLoaded(true);
// // // //       document.body.appendChild(script);
// // // //     } else {
// // // //       setMapLoaded(true);
// // // //     }
// // // //   }, []);

// // // //   useEffect(() => {
// // // //     if (mapLoaded) initMap();
// // // //   }, [mapLoaded]);

// // // //   const initMap = () => {
// // // //     const map = new window.google.maps.Map(mapRef.current, {
// // // //       center: { lat: 40.7829, lng: -73.9654 },
// // // //       zoom: 15,
// // // //     });
// // // //     mapInstanceRef.current = map;

// // // //     const drawingManager = new window.google.maps.drawing.DrawingManager({
// // // //       drawingMode: null,
// // // //       drawingControl: true,
// // // //       drawingControlOptions: {
// // // //         position: window.google.maps.ControlPosition.TOP_CENTER,
// // // //         drawingModes: [
// // // //           window.google.maps.drawing.OverlayType.POLYGON,
// // // //           window.google.maps.drawing.OverlayType.POLYLINE,
// // // //           window.google.maps.drawing.OverlayType.CIRCLE,
// // // //           window.google.maps.drawing.OverlayType.RECTANGLE,
// // // //         ],
// // // //       },
// // // //       polygonOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       polylineOptions: {
// // // //         strokeColor: "#2196F3",
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       rectangleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //       circleOptions: {
// // // //         fillColor: "#2196F3",
// // // //         fillOpacity: 0.4,
// // // //         strokeWeight: 2,
// // // //         clickable: true,
// // // //         editable: false,
// // // //         zIndex: 1,
// // // //       },
// // // //     });

// // // //     drawingManager.setMap(map);

// // // //     window.google.maps.event.addListener(
// // // //       drawingManager,
// // // //       "overlaycomplete",
// // // //       async (event) => {
// // // //         let geojson;
// // // //         let name = prompt("Enter Zone Name");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name cannot be empty.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         switch (event.type) {
// // // //           case "polygon": {
// // // //             const polygon = event.overlay;
// // // //             const path = polygon.getPath().getArray();
// // // //             if (path.length < 3) {
// // // //               alert("Polygon must have at least 3 points.");
// // // //               polygon.setMap(null);
// // // //               return;
// // // //             }
// // // //             let coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);
// // // //             coordinates.push(coordinates[0]); // close polygon

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "polyline": {
// // // //             const polyline = event.overlay;
// // // //             const path = polyline.getPath().getArray();
// // // //             if (path.length < 2) {
// // // //               alert("Line must have at least 2 points.");
// // // //               polyline.setMap(null);
// // // //               return;
// // // //             }
// // // //             const coordinates = path.map((latLng) => [
// // // //               latLng.lng(),
// // // //               latLng.lat(),
// // // //             ]);

// // // //             geojson = {
// // // //               type: "LineString",
// // // //               coordinates,
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "circle": {
// // // //             const circle = event.overlay;
// // // //             const center = circle.getCenter();
// // // //             const radius = circle.getRadius();

// // // //             const points = [];
// // // //             const numPoints = 64;
// // // //             for (let i = 0; i < numPoints; i++) {
// // // //               const angle = (i / numPoints) * 2 * Math.PI;
// // // //               const point = turf.destination(
// // // //                 turf.point([center.lng(), center.lat()]),
// // // //                 radius / 1000,
// // // //                 (angle * 180) / Math.PI,
// // // //                 { units: "kilometers" }
// // // //               );
// // // //               points.push(point.geometry.coordinates);
// // // //             }
// // // //             points.push(points[0]);

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [points],
// // // //             };
// // // //             break;
// // // //           }

// // // //           case "rectangle": {
// // // //             const rectangle = event.overlay;
// // // //             const bounds = rectangle.getBounds();
// // // //             const ne = bounds.getNorthEast();
// // // //             const sw = bounds.getSouthWest();
// // // //             const nw = new window.google.maps.LatLng(ne.lat(), sw.lng());
// // // //             const se = new window.google.maps.LatLng(sw.lat(), ne.lng());

// // // //             const coordinates = [
// // // //               [sw.lng(), sw.lat()],
// // // //               [nw.lng(), nw.lat()],
// // // //               [ne.lng(), ne.lat()],
// // // //               [se.lng(), se.lat()],
// // // //               [sw.lng(), sw.lat()],
// // // //             ];

// // // //             geojson = {
// // // //               type: "Polygon",
// // // //               coordinates: [coordinates],
// // // //             };
// // // //             break;
// // // //           }

// // // //           default:
// // // //             alert("Unsupported shape type");
// // // //             event.overlay.setMap(null);
// // // //             return;
// // // //         }

// // // //         if (
// // // //           (geojson.type === "Polygon" &&
// // // //             !geojsonValidation.isPolygon(geojson)) ||
// // // //           (geojson.type === "LineString" &&
// // // //             !geojsonValidation.isLineString(geojson))
// // // //         ) {
// // // //           alert("Invalid GeoJSON shape. Please try again.");
// // // //           event.overlay.setMap(null);
// // // //           return;
// // // //         }

// // // //         // ✅ Remove the overlay from drawing manager (it will be redrawn by loadZones)
// // // //         event.overlay.setMap(null);

// // // //         await saveZone(name.trim(), geojson);
// // // //       }
// // // //     );

// // // //     loadZones(map);
// // // //   };

// // // //   const saveZone = async (name, geojson) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zone"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify({ name, geojson }),
// // // //       });

// // // //       const result = await res.json();

// // // //       if (res.ok) {
// // // //         console.log("Zone saved:", name);

// // // //         if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //           wsRef.current.send(
// // // //             JSON.stringify({
// // // //               action: "default",
// // // //               type: "zone-update",
// // // //               zoneName: name,
// // // //             })
// // // //           );
// // // //         }

// // // //         // ✅ Show toast
// // // //         toast.success("Zone added successfully!");
// // // //       } else {
// // // //         throw new Error(result.error || "Failed to save zone");
// // // //       }
// // // //     } catch (err) {
// // // //       console.error("Failed to save zone:", err);
// // // //       toast.error("❌ Failed to save zone.");
// // // //     }
// // // //   };

// // // //   const loadZones = async (mapInstance) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl("/zones"));
// // // //       const data = await res.json();
// // // //       setZones(data);

// // // //       const map = mapInstance || mapInstanceRef.current;
// // // //       if (!map) return;

// // // //       // ✅ Clear existing zone overlays before adding new ones
// // // //       clearZoneOverlays();

// // // //       // ✅ Add new zone overlays
// // // //       data.forEach((zone) => {
// // // //         let overlay;

// // // //         if (zone.geojson.type === "Polygon") {
// // // //           overlay = new window.google.maps.Polygon({
// // // //             paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //             fillColor: "#FF0000",
// // // //             fillOpacity: 0.2,
// // // //           });
// // // //         } else if (zone.geojson.type === "LineString") {
// // // //           overlay = new window.google.maps.Polyline({
// // // //             path: zone.geojson.coordinates.map(([lng, lat]) => ({
// // // //               lat,
// // // //               lng,
// // // //             })),
// // // //             strokeColor: "#FF0000",
// // // //             strokeOpacity: 1,
// // // //             strokeWeight: 2,
// // // //           });
// // // //         }

// // // //         if (overlay) {
// // // //           overlay.setMap(map);
// // // //           zoneOverlaysRef.current.push(overlay); // ✅ Track for cleanup
// // // //         }
// // // //       });
// // // //     } catch (err) {
// // // //       console.error("Failed to load zones:", err);
// // // //     }
// // // //   };

// // // //   const sendEmailAlert = async (eventType, zone, point) => {
// // // //     const body = {
// // // //       type: eventType,
// // // //       zoneId: zone.id,
// // // //       zoneName: zone.name,
// // // //       geojson: zone.geojson,
// // // //       point,
// // // //       timestamp: new Date().toISOString(),
// // // //     };

// // // //     try {
// // // //       await fetch(apiUrl("/alert"), {
// // // //         method: "POST",
// // // //         headers: { "Content-Type": "application/json" },
// // // //         body: JSON.stringify(body),
// // // //       });
// // // //       console.log("✅ Email alert sent:", body);
// // // //     } catch (err) {
// // // //       console.error("Failed to send email alert:", err);
// // // //     }
// // // //   };

// // // //   const handleDelete = async (id) => {
// // // //     try {
// // // //       const res = await fetch(apiUrl(`/zone/${id}`), { method: "DELETE" });

// // // //       if (!res.ok) throw new Error("Failed to delete");

// // // //       // ✅ WebSocket broadcast
// // // //       if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
// // // //         wsRef.current.send(
// // // //           JSON.stringify({
// // // //             action: "default",
// // // //             type: "zone-delete",
// // // //             zoneId: id,
// // // //           })
// // // //         );
// // // //       }

// // // //       // ✅ Update UI state
// // // //       setZones((prev) => prev.filter((z) => z.id !== id));
// // // //       loadZones();

// // // //       // ✅ Show toast
// // // //       toast.success("✅ Zone deleted successfully");
// // // //     } catch (err) {
// // // //       console.error("❌ Delete error:", err);
// // // //       toast.error("❌ Failed to delete zone");
// // // //     }
// // // //   };

// // // //   const handleFileUpload = async (event) => {
// // // //     const files = event.target.files;
// // // //     if (!files || files.length === 0) return;

// // // //     for (let file of files) {
// // // //       try {
// // // //         const text = await file.text();
// // // //         const json = JSON.parse(text);

// // // //         if (
// // // //           !geojsonValidation.isPolygon(json) &&
// // // //           !geojsonValidation.isMultiPolygon(json) &&
// // // //           !geojsonValidation.isLineString(json)
// // // //         ) {
// // // //           setUploadStatus(
// // // //             `❌ Invalid GeoJSON in ${file.name}: Only Polygon, MultiPolygon, or LineString supported.`
// // // //           );
// // // //           continue;
// // // //         }

// // // //         const name =
// // // //           prompt(`Enter a name for zone in ${file.name}`) ||
// // // //           file.name.replace(".geojson", "");
// // // //         if (!name || name.trim() === "") {
// // // //           alert("Zone name is required. Skipping " + file.name);
// // // //           continue;
// // // //         }

// // // //         await saveZone(name.trim(), json);
// // // //         setUploadStatus(`✅ Zone uploaded: ${name.trim()}`);
// // // //       } catch (err) {
// // // //         console.error(err);
// // // //         setUploadStatus(`❌ Error reading or uploading ${file.name}.`);
// // // //       }
// // // //     }

// // // //     if (fileInputRef.current) {
// // // //       fileInputRef.current.value = "";
// // // //     }
// // // //   };

// // // //   // Asset movement and geofencing logic
// // // //   useEffect(() => {
// // // //     if (!mapLoaded || zones.length === 0 || !mapInstanceRef.current) return;

// // // //     const interval = setInterval(() => {
// // // //       const deltaLat = (Math.random() - 0.5) * 0.0005;
// // // //       const deltaLng = (Math.random() - 0.5) * 0.0005;

// // // //       setAssetPosition((prev) => {
// // // //         const newPos = {
// // // //           lat: prev.lat + deltaLat,
// // // //           lng: prev.lng + deltaLng,
// // // //         };

// // // //         try {
// // // //           LatLngSchema.parse(newPos);
// // // //         } catch (err) {
// // // //           console.warn("Invalid coordinates, skipping...");
// // // //           return prev;
// // // //         }

// // // //         const point = turf.point([newPos.lng, newPos.lat]);
// // // //         let inside = false;
// // // //         let matchedZone = null;

// // // //         for (let zone of zones) {
// // // //           if (zone.geojson.type === "Polygon") {
// // // //             const polygon = turf.polygon(zone.geojson.coordinates);
// // // //             if (turf.booleanPointInPolygon(point, polygon)) {
// // // //               inside = true;
// // // //               matchedZone = zone;
// // // //               break;
// // // //             }
// // // //           }
// // // //         }

// // // //         const timestamp = new Date().toLocaleString();

// // // //         if (inside && !inZone) {
// // // //           setInZone(true);
// // // //           lastZoneRef.current = matchedZone.name;

// // // //           setEventLog((prev) => [
// // // //             { type: "Entered", zone: matchedZone.name, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("ENTER", matchedZone, point);
// // // //         } else if (!inside && inZone) {
// // // //           setInZone(false);

// // // //           const exitedZoneName = lastZoneRef.current || "Unknown";
// // // //           lastZoneRef.current = null;

// // // //           setEventLog((prev) => [
// // // //             { type: "Exited", zone: exitedZoneName, time: timestamp },
// // // //             ...prev,
// // // //           ]);
// // // //           sendEmailAlert("EXIT", matchedZone, point);
// // // //         }

// // // //         // 🟢 Marker handling
// // // //         const map = mapInstanceRef.current;
// // // //         if (!markerRef.current) {
// // // //           markerRef.current = new window.google.maps.Marker({
// // // //             map,
// // // //             title: "Asset",
// // // //             icon: {
// // // //               path: window.google.maps.SymbolPath.CIRCLE,
// // // //               scale: 6,
// // // //               fillColor: inside ? "#0f0" : "#f00",
// // // //               fillOpacity: 1,
// // // //               strokeWeight: 1,
// // // //             },
// // // //           });
// // // //         }

// // // //         markerRef.current.setIcon({
// // // //           path: window.google.maps.SymbolPath.CIRCLE,
// // // //           scale: 6,
// // // //           fillColor: inside ? "#0f0" : "#f00",
// // // //           fillOpacity: 1,
// // // //           strokeWeight: 1,
// // // //         });
// // // //         markerRef.current.setPosition(
// // // //           new window.google.maps.LatLng(newPos.lat, newPos.lng)
// // // //         );

// // // //         return newPos;
// // // //       });
// // // //     }, 1000);

// // // //     return () => clearInterval(interval);
// // // //   }, [zones, mapLoaded, inZone]);

// // // //   // ✅ Enhanced WebSocket connection with proper message handling
// // // //   useEffect(() => {
// // // //     const socket = new WebSocket(
// // // //       "wss://gzor3mc31j.execute-api.us-east-1.amazonaws.com/$default"
// // // //     );
// // // //     wsRef.current = socket;

// // // //     socket.onopen = () => {
// // // //       console.log("✅ WebSocket connected");
// // // //       setWsStatus("Connected");
// // // //     };

// // // //     socket.onclose = () => {
// // // //       console.warn("❌ WebSocket disconnected");
// // // //       setWsStatus("Disconnected");
// // // //     };

// // // //     socket.onerror = (err) => {
// // // //       console.error("🚨 WebSocket error", err);
// // // //       setWsStatus("Error");
// // // //     };

// // // //     socket.onmessage = (event) => {
// // // //       try {
// // // //         const data = JSON.parse(event.data);
// // // //         console.log("📨 WebSocket message received:", data);

// // // //         // ✅ Handle different message types
// // // //         if (data.type === "zone-update") {
// // // //           console.log("🔄 Reloading zones due to update...");
// // // //           loadZones(); // This will clear and reload all zones
// // // //         } else if (data.type === "zone-delete") {
// // // //           console.log("🗑️ Reloading zones due to deletion...");
// // // //           loadZones(); // Reload zones after deletion
// // // //         }
// // // //       } catch (err) {
// // // //         console.error("Failed to parse WebSocket message:", err);
// // // //       }
// // // //     };

// // // //     return () => {
// // // //       socket.close();
// // // //     };
// // // //   }, []);

// // // //   // ✅ Cleanup function to clear overlays when component unmounts
// // // //   useEffect(() => {
// // // //     return () => {
// // // //       clearZoneOverlays();
// // // //     };
// // // //   }, []);

// // // //   return (
// // // //     <Box sx={{ p: 3 }}>
// // // //       <Typography variant="h4" gutterBottom>
// // // //         Zone Manager
// // // //       </Typography>

// // // //       <Box sx={{ mb: 2 }}>
// // // //         <Typography
// // // //           variant="caption"
// // // //           color={wsStatus === "Connected" ? "success.main" : "error.main"}
// // // //         >
// // // //           WebSocket: {wsStatus}
// // // //         </Typography>
// // // //       </Box>

// // // //       <Box
// // // //         ref={mapRef}
// // // //         style={{ width: "100%", height: "500px", marginBottom: "24px" }}
// // // //       />

// // // //       <Box sx={{ mb: 3 }}>
// // // //         <Typography variant="h6">📂 Upload GeoJSON Zone</Typography>
// // // //         <input
// // // //           type="file"
// // // //           ref={fileInputRef}
// // // //           accept=".geojson,application/geo+json"
// // // //           onChange={handleFileUpload}
// // // //           multiple
// // // //           style={{ marginBottom: "8px" }}
// // // //         />
// // // //         {uploadStatus && (
// // // //           <Typography
// // // //             variant="body2"
// // // //             color={
// // // //               uploadStatus.startsWith("✅") ? "success.main" : "error.main"
// // // //             }
// // // //           >
// // // //             {uploadStatus}
// // // //           </Typography>
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />
// // // //       <Box>
// // // //         <Typography variant="h6">🗂️ Saved Zones ({zones.length})</Typography>

// // // //         {zones.length === 0 ? (
// // // //           <Typography>
// // // //             No zones available. Draw zones on the map or upload GeoJSON files.
// // // //           </Typography>
// // // //         ) : (
// // // //           zones.map((zone) => (
// // // //             <Box
// // // //               key={zone.id}
// // // //               sx={{
// // // //                 mb: 1,
// // // //                 p: 1,
// // // //                 border: 1,
// // // //                 borderColor: "grey.300",
// // // //                 borderRadius: 1,
// // // //               }}
// // // //             >
// // // //               <Typography variant="body1">{zone.name}</Typography>
// // // //               <Typography variant="caption" color="text.secondary">
// // // //                 Type: {zone.geojson.type}
// // // //               </Typography>
// // // //               <Box sx={{ mt: 1 }}>
// // // //                 <Button
// // // //                   variant="outlined"
// // // //                   color="error"
// // // //                   size="small"
// // // //                   onClick={() => handleDelete(zone.id)}
// // // //                 >
// // // //                   Delete Zone
// // // //                 </Button>
// // // //               </Box>
// // // //             </Box>
// // // //           ))
// // // //         )}
// // // //       </Box>

// // // //       <Divider sx={{ my: 3 }} />

// // // //       <Box>
// // // //         <Typography variant="h6">🕒 Entry/Exit Log</Typography>
// // // //         {eventLog.length === 0 ? (
// // // //           <Typography>
// // // //             No events yet. Asset movement will be logged here.
// // // //           </Typography>
// // // //         ) : (
// // // //           <List>
// // // //             {eventLog.slice(0, 10).map((log, idx) => (
// // // //               <ListItem key={idx} sx={{ py: 0.5 }}>
// // // //                 <ListItemText
// // // //                   primary={`${log.type} - ${log.zone}`}
// // // //                   secondary={log.time}
// // // //                 />
// // // //               </ListItem>
// // // //             ))}
// // // //           </List>
// // // //         )}
// // // //       </Box>
// // // //     </Box>
// // // //   );
// // // // };

// // // // export default ZoneManager;

// // // // // import React from 'react'
// // // // // import { GoogleMap, LoadScript, Marker, Polygon } from '@react-google-maps/api'

// // // // // function ViewMap({points,setModalView,color,latitude,longitude}) {
// // // // //   return (
// // // // //     <div className="App">
// // // // //           <LoadScript
// // // // //             id="script-loader"
// // // // //             googleMapsApiKey={process.env.REACT_APP_GOOGLEAPI}
// // // // //             language="en"
// // // // //             region="us"
// // // // //           >
// // // // //             {
// // // // //               points.length > 1

// // // // //                 ?
// // // // //                 <GoogleMap
// // // // //                   mapContainerClassName='appmap'
// // // // //                   center={points[0]}
// // // // //                   zoom={12}
// // // // //                 >
// // // // //                   <Polygon
// // // // //                     path={points}
// // // // //                     options={{
// // // // //                       fillColor: color,
// // // // //                       strokeColor: '#2196F3',
// // // // //                       fillOpacity: 0.5,
// // // // //                       strokeWeight: 2
// // // // //                     }}
// // // // //                   />
// // // // //               <Marker
// // // // //                 position={{ lat: Number(latitude), lng: Number(longitude) }}
// // // // //               />

// // // // //                 </GoogleMap>
// // // // //                 :
// // // // //                 null
// // // // //             }

// // // // //           </LoadScript>

// // // // //           <button onClick={() => setModalView(false)}>Close</button>
// // // // //         </div>
// // // // //   )
// // // // // }

// // // // // export default ViewMap
