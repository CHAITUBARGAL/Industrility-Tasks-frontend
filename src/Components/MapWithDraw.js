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
import {
  Delete as DeleteIcon,
  Refresh as RefreshIcon,
} from "@mui/icons-material";
import { Loader } from "@googlemaps/js-api-loader";

// Mock API configuration - replace with your actual values
const GOOGLE_MAP_API_KEY = process.env.REACT_APP_GOOGLEAPI;
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL;
const WS_API_ENDPOINT = `${process.env.REACT_APP_WS_URL}/$default`;

function apiUrl(path) {
  return `${API_BASE_URL}${path}`;
}

// Validation schemas (simplified)
const validateZone = (zone) => {
  return (
    zone &&
    zone.id &&
    zone.name &&
    zone.geojson &&
    zone.geojson.type &&
    zone.geojson.coordinates
  );
};

const ZoneManager = () => {
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const drawingManagerRef = useRef(null);
  const fileInputRef = useRef(null);
  const zoneOverlaysRef = useRef([]);
  const lastZoneRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const zoneEntryTimeRef = useRef(null);

  // State management
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapInitialized, setMapInitialized] = useState(false);
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

  // Clear existing zone overlays from map
  const clearZoneOverlays = useCallback(() => {
    zoneOverlaysRef.current.forEach(({ overlay }) => {
      if (overlay && overlay.setMap) {
        overlay.setMap(null);
      }
    });
    zoneOverlaysRef.current = [];
  }, []);

  // Load Google Maps API

  useEffect(() => {
    const loader = new Loader({
      apiKey: GOOGLE_MAP_API_KEY,
      libraries: ["drawing"],
    });

    loader
      .load()
      .then(() => {
        if (window.google) {
          setMapLoaded(true);
          // console.log("✅ Google Maps loaded");
        } else {
          setUploadStatus(
            "❌ Google Maps loaded, but window.google is undefined"
          );
        }
      })
      .catch((err) => {
        console.error("❌ Failed to load Google Maps:", err);
        setUploadStatus("❌ Failed to load Google Maps API");
      });
  }, []);

  // Initialize map when Google Maps API is loaded
  useEffect(() => {
    if (mapLoaded && !mapInitialized && mapRef.current) {
      initMap();
    }
  }, [mapLoaded, mapInitialized]);

  const handleDrawingComplete = useCallback(async (event) => {
    let geojson;
    const name = prompt("Enter Zone Name");

    if (!name || name.trim() === "") {
      alert("Zone name cannot be empty.");
      if (event.overlay && event.overlay.setMap) {
        event.overlay.setMap(null);
      }
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
            const lat = center.lat() + (radius / 111000) * Math.cos(angle);
            const lng =
              center.lng() +
              (radius / (111000 * Math.cos((center.lat() * Math.PI) / 180))) *
                Math.sin(angle);
            points.push([lng, lat]);
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

          const coordinates = [
            [sw.lng(), sw.lat()],
            [sw.lng(), ne.lat()],
            [ne.lng(), ne.lat()],
            [ne.lng(), sw.lat()],
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

      if (event.overlay && event.overlay.setMap) {
        event.overlay.setMap(null);
      }

      await saveZone(name.trim(), geojson);
    } catch (error) {
      // console.error("Drawing error:", error);
      alert(error.message);
      if (event.overlay && event.overlay.setMap) {
        event.overlay.setMap(null);
      }
    }
  }, []);

  const loadZones = useCallback(async () => {
    if (!mapInstanceRef.current) return;

    try {
      setLoading(true);
      // console.log("🔄 Loading zones...");

      const res = await fetch(apiUrl("/zones"));
      const data = await res.json();

      if (!Array.isArray(data)) {
        throw new Error(
          "Zones response is not an array: " + JSON.stringify(data)
        );
      }

      const validatedZones = data.filter(validateZone);
      setZones(validatedZones);
      clearZoneOverlays();

      validatedZones.forEach((zone) => {
        let overlay;

        if (zone.geojson.type === "Polygon") {
          overlay = new window.google.maps.Polygon({
            paths: zone.geojson.coordinates[0].map(([lng, lat]) => ({
              lat,
              lng,
            })),
            strokeColor: "#FF0000",
            fillColor: "#FF0000",
            fillOpacity: 0.2,
          });
        }

        if (overlay) {
          overlay.setMap(mapInstanceRef.current);
          zoneOverlaysRef.current.push({ id: zone.id, overlay });
          setZoneVisibility((prev) => ({ ...prev, [zone.id]: true }));
        }
      });

      // console.log("✅ Zones loaded successfully");
    } catch (err) {
      console.error("❌ Failed to load zones:", err);
      setUploadStatus(`❌ Load error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [clearZoneOverlays]);

  const initMap = useCallback(() => {
    if (!mapRef.current || !window.google || mapInstanceRef.current) {
      return;
    }

    // console.log("🗺️ Initializing map...");

    try {
      const map = new window.google.maps.Map(mapRef.current, {
        center: assetPosition,
        zoom: 15,
        mapTypeControl: true,
        streetViewControl: true,
        fullscreenControl: true,
      });

      mapInstanceRef.current = map;

      // Initialize drawing manager
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
      drawingManagerRef.current = drawingManager;

      // Handle drawing completion
      window.google.maps.event.addListener(
        drawingManager,
        "overlaycomplete",
        handleDrawingComplete
      );

      // Create initial asset marker
      const marker = new window.google.maps.Marker({
        position: assetPosition,
        map: map,
        title: "Live Asset Location",
        icon: {
          url: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png",
          scaledSize: new window.google.maps.Size(40, 40),
        },
      });

      markerRef.current = marker;

      setMapInitialized(true);
      // console.log("✅ Map initialized successfully");

      loadZones();
    } catch (error) {
      console.error("❌ Map initialization failed:", error);
      setUploadStatus(`❌ Map initialization failed: ${error.message}`);
    }
  }, [assetPosition, handleDrawingComplete, loadZones]);

  const saveZone = useCallback(
    async (name, geojson) => {
      setLoading(true);
      try {
        // console.log("💾 Saving zone:", name);

        const res = await fetch(apiUrl("/zone"), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name, geojson }),
        });

        if (!res.ok) throw new Error("Failed to save");

        // console.log("✅ Zone saved:", name);
        setUploadStatus(`✅ Zone "${name}" saved successfully!`);

        await loadZones();
      } catch (err) {
        console.error("❌ Failed to save zone:", err);
        setUploadStatus(`❌ Failed to save zone: ${err.message}`);
      } finally {
        setLoading(false);
      }
    },
    [loadZones]
  );

  const sendEmailAlert = useCallback(async (eventType, zone, point) => {
    const body = {
      type: eventType,
      zoneId: zone.id,
      zoneName: zone.name,
      geojson: zone.geojson,
      point,
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(apiUrl("/alert"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`HTTP ${res.status}: ${res.statusText} - ${errorText}`);
      }

      // console.log("✅ Email alert sent:", body);
    } catch (err) {
      console.error("❌ Failed to send email alert:", err);
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
          const errorText = await res.text();
          throw new Error(
            `HTTP ${res.status}: ${res.statusText} - ${errorText}`
          );
        }

        // console.log("✅ Log saved to DB");
      } catch (err) {
        console.error("❌ Failed to save log to DB:", err);
      }
    },
    []
  );

  const handleDelete = async (zoneId) => {
    try {
      setLoading(true);
      // console.log("🗑️ Deleting zone:", zoneId);

      const res = await fetch(apiUrl(`/zone/${zoneId}`), {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Failed to delete zone from server");
      }

      const remainingOverlays = zoneOverlaysRef.current.filter((z) => {
        if (z.id === zoneId) {
          if (z.overlay && z.overlay.setMap) {
            z.overlay.setMap(null);
          }
          return false;
        }
        return true;
      });
      zoneOverlaysRef.current = remainingOverlays;

      setZones((prev) => prev.filter((z) => z.id !== zoneId));
      setZoneVisibility((prev) => {
        const newState = { ...prev };
        delete newState[zoneId];
        return newState;
      });

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            action: "default",
            type: "zone-delete",
            zoneId,
            timestamp: new Date().toISOString(),
          })
        );
      }

      // console.log("✅ Zone deleted successfully");
      setUploadStatus("✅ Zone deleted successfully");
    } catch (err) {
      console.error("❌ Delete failed:", err);
      setUploadStatus(`❌ Delete failed: ${err.message}`);
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

          if (!json.type || !json.coordinates) {
            throw new Error("Invalid GeoJSON format");
          }

          if (!["Polygon", "MultiPolygon", "LineString"].includes(json.type)) {
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

      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      setLoading(false);
    },
    [saveZone]
  );

  const fetchAllLogs = useCallback(async () => {
    try {
      // console.log("📊 Fetching all logs...");

      const res = await fetch(apiUrl("/logs"));
      if (!res.ok) throw new Error(`Failed to fetch: ${res.statusText}`);

      const data = await res.json();
      const sortedLogs = data.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      setAllLogs(sortedLogs);
    } catch (err) {
      console.error("❌ Failed to fetch logs:", err);
      setUploadStatus("❌ Failed to fetch logs");
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

  // Geofencing logic
  const checkGeofencing = useCallback(
    (newPosition) => {
      if (!zones.length) return;

      const point = [newPosition.lng, newPosition.lat];
      let matchedZone = null;

      for (let zone of zones) {
        if (zone.geojson.type === "Polygon") {
          try {
            const polygon = zone.geojson.coordinates[0];
            let inside = false;

            for (
              let i = 0, j = polygon.length - 1;
              i < polygon.length;
              j = i++
            ) {
              if (
                polygon[i][1] > point[1] !== polygon[j][1] > point[1] &&
                point[0] <
                  ((polygon[j][0] - polygon[i][0]) *
                    (point[1] - polygon[i][1])) /
                    (polygon[j][1] - polygon[i][1]) +
                    polygon[i][0]
              ) {
                inside = !inside;
              }
            }

            if (inside) {
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
        // Entered zone
        lastZoneRef.current = matchedZone;
        zoneEntryTimeRef.current = ts;
        setInZone(true);
        setCurrentZone(matchedZone);
        setEventLog((prev) => [
          { type: "Entered", zone: matchedZone.name, time: ts },
          ...prev.slice(0, 9),
        ]);
        setUploadStatus(`🚧 Entered zone ${matchedZone.name}`);
        sendEmailAlert("ENTER", matchedZone, point);
        postLogEvent({
          zoneId: matchedZone.id,
          zoneName: matchedZone.name,
          type: "ENTER",
          timestamp: ts,
        });
      } else if (!inside && wasInside) {
        // Exited zone
        const exitedZone = lastZoneRef.current;
        lastZoneRef.current = null;
        setInZone(false);
        setCurrentZone(null);

        let durationStr = "";
        if (zoneEntryTimeRef.current) {
          const entryTime = new Date(zoneEntryTimeRef.current).getTime();
          const exitTime = new Date(ts).getTime();
          const durationMs = exitTime - entryTime;
          const minutes = Math.floor(durationMs / 60000);
          const seconds = Math.floor((durationMs % 60000) / 1000);
          durationStr = `${minutes}m ${seconds}s`;
        }

        setEventLog((prev) => [
          {
            type: "Exited",
            zone: exitedZone?.name || "Unknown",
            time: ts,
            duration: durationStr ? `Stayed for ${durationStr}` : undefined,
          },
          ...prev.slice(0, 9),
        ]);
        setUploadStatus(
          `🏁 Exited ${exitedZone?.name || "zone"}${
            durationStr ? ` after ${durationStr}` : ""
          }`
        );
        sendEmailAlert("EXIT", exitedZone || {}, point);
        postLogEvent({
          zoneId: exitedZone?.id || "unknown",
          zoneName: exitedZone?.name || "unknown",
          type: "EXIT",
          timestamp: ts,
        });
      }
    },
    [zones, sendEmailAlert]
  );

  // Asset position updates
  useEffect(() => {
    if (!mapInstanceRef.current) return;

    if (markerRef.current) {
      markerRef.current.setPosition(
        new window.google.maps.LatLng(assetPosition.lat, assetPosition.lng)
      );
    }

    if (assetMoving) {
      checkGeofencing(assetPosition);
    }
  }, [assetPosition, assetMoving, checkGeofencing]);

  useEffect(() => {
    let reconnectTimeout;

    const connectWebSocket = () => {
      wsRef.current = new WebSocket(WS_API_ENDPOINT);

      wsRef.current.onopen = () => {
        setWsStatus("Connected");
        // console.log("✅ WebSocket connected");
      };

      wsRef.current.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          // console.log("📨 WebSocket received:", data);

          if (data.type === "zone-update" || data.type === "zone-delete") {
            // console.log(
            //   `🔁 Reloading zones due to ${data.type.toUpperCase()} event`
            // );
            loadZones();
          } else if (data.type === "assetLocationUpdate") {
            const { assetId, lat, lng, timestamp } = data.data || {};
            setAssetPosition({ lat, lng });
          } else if (data.type === "log-event") {
            // console.log("🆕 Real-time log received:", data.data);
            setAllLogs((prev) => [data.data, ...prev]);
          } else {
            console.warn("❓ Unknown WebSocket message type:", data.type);
          }
        } catch (error) {
          console.error("❌ Failed to parse WebSocket message:", error);
        }
      };

      wsRef.current.onclose = () => {
        setWsStatus("Disconnected");
        console.warn("⚠️ WebSocket disconnected. Reconnecting in 5 seconds...");
        reconnectTimeout = setTimeout(connectWebSocket, 5000);
      };

      wsRef.current.onerror = (error) => {
        console.error("❌ WebSocket error:", error);
        wsRef.current.close(); // Trigger reconnect
      };
    };

    connectWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      clearTimeout(reconnectTimeout);
    };
  }, []);

  useEffect(() => {
    fetchAllLogs();
  }, [fetchAllLogs]);

  useEffect(() => {
    return () => {
      clearZoneOverlays();
    };
  }, [clearZoneOverlays]);

  const toggleAssetMovement = useCallback(() => {
    setAssetMoving((prev) => !prev);
  }, []);

  const refreshZones = useCallback(() => {
    loadZones();
  }, [loadZones]);

  if (!mapLoaded) {
    return (
      <Box sx={{ p: 3, textAlign: "center" }}>
        <LinearProgress sx={{ mb: 2 }} />
        <Typography>Loading Google Maps...</Typography>
      </Box>
    );
  }
  const postLogEvent = async ({ zoneId, zoneName, type, timestamp }) => {
    try {
      const res = await fetch(apiUrl("/log-event"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zoneId, zoneName, type, timestamp }),
      });

      if (!res.ok) {
        console.error("❌ Failed to post log:", await res.text());
      } else {
        // console.log("📤 Log posted successfully");
      }
    } catch (err) {
      console.error("❌ Error posting log event:", err);
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: "auto" }}>
      <Typography variant="h4" gutterBottom>
        🗺️ Zone Manager
      </Typography>

      {/* Status indicators */}
      <Box
        sx={{
          mb: 2,
          display: "flex",
          gap: 2,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
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
        <Chip
          label={`Map: ${mapInitialized ? "Ready" : "Loading"}`}
          color={mapInitialized ? "success" : "warning"}
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

      {/* Status message */}
      {uploadStatus && (
        <Alert
          severity={
            uploadStatus.startsWith("✅")
              ? "success"
              : uploadStatus.startsWith("❌")
              ? "error"
              : "info"
          }
          sx={{ mb: 2 }}
          onClose={() => setUploadStatus("")}
        >
          {uploadStatus}
        </Alert>
      )}

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
          backgroundColor: "#f5f5f5",
        }}
      />

      {/* Asset controls */}
      <Box sx={{ mb: 3, display: "flex", gap: 2, flexWrap: "wrap" }}>
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
        <Button variant="outlined" component="label">
          Upload GeoJSON
          <input
            type="file"
            multiple
            hidden
            accept=".geojson,application/geo+json"
            ref={fileInputRef}
            onChange={handleFileUpload}
          />
        </Button>
      </Box>

      {/* Zone list with visibility and delete */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          Zones ({zones.length})
        </Typography>
        <List dense>
          {zones.map((zone) => (
            <ListItem
              key={zone.id}
              secondaryAction={
                <>
                  <Tooltip title="Toggle Visibility">
                    <Button
                      size="small"
                      onClick={() => toggleZoneVisibility(zone.id)}
                    >
                      {zoneVisibility[zone.id] ? "Hide" : "Show"}
                    </Button>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      edge="end"
                      onClick={() => handleDelete(zone.id)}
                      color="error"
                    >
                      <DeleteIcon />
                    </IconButton>
                  </Tooltip>
                </>
              }
            >
              <ListItemText
                primary={zone.name}
                secondary={`Type: ${zone.geojson?.type || "Unknown"}`}
              />
            </ListItem>
          ))}
        </List>
      </Box>

      <Divider sx={{ my: 3 }} />

      {/* Event Log (latest 10 events) */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          🧭 Live Entry/Exit Events (Last 10)
        </Typography>
        <List dense>
          {eventLog.map((log, index) => (
            <ListItem key={index}>
              <ListItemText
                primary={`${log.type} - ${log.zone}`}
                secondary={`${new Date(log.time).toLocaleString()}${
                  log.duration ? ` - ${log.duration}` : ""
                }`}
              />
            </ListItem>
          ))}
        </List>
      </Box>

      {/* Divider */}
      <Divider sx={{ my: 3 }} />

      {/* All Logs */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="h6" gutterBottom>
          📜 History Log ({allLogs.length})
        </Typography>

        {/* Filter */}
        <Box sx={{ mb: 2, display: "flex", alignItems: "center", gap: 2 }}>
          <Typography variant="body1">Filter:</Typography>
          <Select
            size="small"
            value={selectedZoneFilter}
            onChange={(e) => setSelectedZoneFilter(e.target.value)}
          >
            <MenuItem value="All">All</MenuItem>
            {[...new Set(allLogs.map((log) => log.zoneName))].map((name) => (
              <MenuItem key={name} value={name}>
                {name}
              </MenuItem>
            ))}
          </Select>
        </Box>

        <Grid container spacing={2}>
          {allLogs
            .filter(
              (log) =>
                selectedZoneFilter === "All" ||
                log.zoneName === selectedZoneFilter
            )
            .map((log) => (
              <Grid item xs={12} md={6} key={log.id}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle1" fontWeight="bold">
                      {log.type === "ENTER" ? "🟢 Entered" : "🔴 Exited"}{" "}
                      {log.zoneName}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Zone ID: {log.zoneId}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      Timestamp: {new Date(log.timestamp).toLocaleString()}
                    </Typography>
                  </CardContent>
                </Card>
              </Grid>
            ))}
        </Grid>
      </Box>
    </Box>
  );
};

export default ZoneManager;
