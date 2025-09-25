import { useEffect } from "react";
import io from "socket.io-client";
import "./App.css";

// The backend server is running on Render
const API_URL = "https://rxj-info-api.onrender.com";

function App() {
  useEffect(() => {
    // Connect to the signaling server
    const socket = io(API_URL);

    socket.on("connect", () => {
      console.log(
        "Successfully connected to the signaling server with ID:",
        socket.id
      );
    });

    // Clean up the connection when the component unmounts
    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <div className="App">
      <header className="App-header">
        <h1>Peer-to-Peer File Sharer</h1>
        <p>Connecting to network...</p>
      </header>
    </div>
  );
}

export default App;
