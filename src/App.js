import "./App.css";
import { BrowserRouter as Router } from "react-router-dom";
import MapWithDraw from "./Components/MapWithDraw";
import { Toaster } from "react-hot-toast";
function App() {
  return (
    <div className="App">
      <Toaster position="top-right" />
      <Router>
        <MapWithDraw />
      </Router>
    </div>
  );
}
export default App;
