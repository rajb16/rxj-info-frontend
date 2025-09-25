import { useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import io from "socket.io-client";
import "./App.css";

const API_URL = "https://rxj-info-api.onrender.com";

function App() {
  const [status, setStatus] = useState("Connecting to network...");
  const [peers, setPeers] = useState({});
  const socketRef = useRef();
  const peersRef = useRef({});

  useEffect(() => {
    // 1. Connect to the signaling server
    socketRef.current = io(API_URL);
    setStatus("Successfully connected to the signaling server!");

    // 2. Listen for the list of all connected users
    socketRef.current.on("all users", (users) => {
      setStatus("Network active. Searching for peers...");
      users.forEach((userID) => {
        const peer = createPeer(userID, socketRef.current.id);
        peersRef.current[userID] = peer;
        setPeers((prevPeers) => ({ ...prevPeers, [userID]: peer }));
      });
    });

    // 3. Listen for a new user joining the network
    socketRef.current.on("user joined", (payload) => {
      setStatus("A new peer joined! Connecting...");
      const peer = addPeer(payload.signal, payload.callerID);
      peersRef.current[payload.callerID] = peer;
      setPeers((prevPeers) => ({ ...prevPeers, [payload.callerID]: peer }));
    });

    // 4. Listen for signals from other peers
    socketRef.current.on("signal returned", (payload) => {
      const peer = peersRef.current[payload.id];
      peer.signal(payload.signal);
    });

    // Clean up on component unmount
    return () => {
      socketRef.current.disconnect();
      Object.values(peersRef.current).forEach((peer) => peer.destroy());
    };
  }, []);

  // Function to create a new peer connection (for the initiator)
  function createPeer(userToSignal, callerID) {
    const peer = new Peer({
      initiator: true,
      trickle: false,
    });

    peer.on("signal", (signal) => {
      socketRef.current.emit("sending signal", {
        userToSignal,
        callerID,
        signal,
      });
    });

    peer.on("connect", () => {
      setStatus(`Connected to a peer!`);
    });

    return peer;
  }

  // Function to add a new peer connection (for the receiver)
  function addPeer(incomingSignal, callerID) {
    const peer = new Peer({
      initiator: false,
      trickle: false,
    });

    peer.on("signal", (signal) => {
      socketRef.current.emit("returning signal", { signal, callerID });
    });

    peer.on("connect", () => {
      setStatus(`Connected to a peer!`);
    });

    peer.signal(incomingSignal);
    return peer;
  }

  return (
    <div className="App">
      <header className="App-header">
        <h1>Peer-to-Peer File Sharer</h1>
        <p>
          Status: <strong>{status}</strong>
        </p>
      </header>
    </div>
  );
}

export default App;
