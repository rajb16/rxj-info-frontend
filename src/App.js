import { useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import io from "socket.io-client";
import "./App.css";

const API_URL = "https://rxj-info-api.onrender.com";

function App() {
  // State variables
  const [status, setStatus] = useState("Connecting to network...");
  const [peers, setPeers] = useState({});
  const [myFiles, setMyFiles] = useState({});
  const [peerFiles, setPeerFiles] = useState({});

  // Refs for persistent objects
  const socketRef = useRef();
  const peersRef = useRef({});
  const fileChunksRef = useRef({});

  useEffect(() => {
    socketRef.current = io(API_URL);
    setStatus("Successfully connected to the signaling server!");

    socketRef.current.on("all users", (users) => {
      setStatus("Network active. Searching for peers...");
      users.forEach((userID) => {
        const peer = createPeer(userID, socketRef.current.id);
        peersRef.current[userID] = peer;
        setPeers((prev) => ({ ...prev, [userID]: peer }));
      });
    });

    socketRef.current.on("user joined", (userID) => {
      setStatus("A new peer joined! Connecting...");
      const peer = createPeer(userID, socketRef.current.id);
      peersRef.current[userID] = peer;
      setPeers((prev) => ({ ...prev, [userID]: peer }));
    });

    socketRef.current.on("signal received", (payload) => {
      const peer = addPeer(payload.signal, payload.callerID);
      peersRef.current[payload.callerID] = peer;
      setPeers((prev) => ({ ...prev, [payload.callerID]: peer }));
    });

    socketRef.current.on("signal returned", (payload) => {
      peersRef.current[payload.id]?.signal(payload.signal);
    });

    socketRef.current.on("user left", (userID) => {
      setStatus("A peer has left the network.");
      if (peersRef.current[userID]) {
        peersRef.current[userID].destroy();
        delete peersRef.current[userID];
      }
      setPeers((prev) => {
        const newPeers = { ...prev };
        delete newPeers[userID];
        return newPeers;
      });
    });

    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      Object.values(peersRef.current).forEach((peer) => peer.destroy());
    };
  }, []);

  // --- PEER CREATION LOGIC ---
  function createPeer(userToSignal, callerID) {
    const peer = new Peer({ initiator: true, trickle: false });
    peer.on("signal", (signal) =>
      socketRef.current.emit("sending signal", {
        userToSignal,
        callerID,
        signal,
      })
    );
    peer.on("connect", () => setupPeerEvents(peer));
    return peer;
  }

  function addPeer(incomingSignal, callerID) {
    const peer = new Peer({ initiator: false, trickle: false });
    peer.on("signal", (signal) =>
      socketRef.current.emit("returning signal", { signal, callerID })
    );
    peer.on("connect", () => setupPeerEvents(peer));
    peer.signal(incomingSignal);
    return peer;
  }

  // --- EVENT HANDLING & DATA TRANSFER ---
  function setupPeerEvents(peer) {
    setStatus(`Connected to a peer! Ready to share.`);
    // ** THE KEY FIX IS HERE: We now pass the specific 'peer' into the handler **
    peer.on("data", (data) => handleData(data, peer));

    // Announce our files to the new peer
    const fileList = Object.values(myFiles).map((f) => ({
      name: f.name,
      size: f.size,
    }));
    if (fileList.length > 0) {
      peer.send(JSON.stringify({ type: "file-list", files: fileList }));
    }
  }

  function handleData(data, peer) {
    // Note the 'peer' argument here now
    try {
      const message = JSON.parse(data);
      if (message.type === "file-list") {
        setPeerFiles((prev) => ({
          ...prev,
          ...message.files.reduce(
            (obj, file) => ({ ...obj, [file.name]: file }),
            {}
          ),
        }));
      } else if (message.type === "file-request") {
        const file = myFiles[message.name];
        if (file) {
          sendFile(file, peer); // We now have the correct peer to send to
        }
      } else if (message.type === "file-chunk") {
        if (!fileChunksRef.current[message.name])
          fileChunksRef.current[message.name] = [];
        fileChunksRef.current[message.name].push(message.chunk);
      } else if (message.type === "file-done") {
        const completeFile = new Blob(fileChunksRef.current[message.name]);
        const url = URL.createObjectURL(completeFile);
        const a = document.createElement("a");
        a.href = url;
        a.download = message.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        delete fileChunksRef.current[message.name];
      }
    } catch (e) {
      console.error("Error handling data", e);
    }
  }

  function handleFileSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fileInfo = { name: file.name, size: file.size };
    setMyFiles((prev) => ({ ...prev, [file.name]: file }));
    Object.values(peersRef.current).forEach((peer) => {
      peer.send(JSON.stringify({ type: "file-list", files: [fileInfo] }));
    });
    e.target.value = "";
  }

  function requestFile(fileName) {
    // Find the peer who has the file (in a multi-peer setup, this would be more complex)
    // For now, we just ask everyone.
    Object.values(peersRef.current).forEach((peer) => {
      peer.send(JSON.stringify({ type: "file-request", name: fileName }));
    });
  }

  function sendFile(file, peer) {
    const chunkSize = 64 * 1024;
    const reader = new FileReader();
    let offset = 0;
    reader.onload = (e) => {
      if (e.target.error) {
        console.error("Error reading file:", e.target.error);
        return;
      }
      // Use ArrayBuffer directly
      peer.send(e.target.result);
      offset += e.target.result.byteLength;
      if (offset < file.size) {
        readSlice(offset);
      } else {
        // Signal end of file
        peer.send(JSON.stringify({ type: "file-done", name: file.name }));
      }
    };
    const readSlice = (o) => {
      const slice = file.slice(o, o + chunkSize);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  }

  // --- JSX RENDER ---
  return (
    <div className="App">
      <header className="App-header">
        <h1>Peer-to-Peer File Sharer</h1>
        <p>
          Status: <strong>{status}</strong>
        </p>
        <div className="file-container">
          <div className="my-files">
            <h2>My Shareable Files</h2>
            <input type="file" onChange={handleFileSelect} />
            <ul>
              {Object.values(myFiles).map((file) => (
                <li key={file.name}>
                  {file.name} ({(file.size / 1024).toFixed(2)} KB)
                </li>
              ))}
            </ul>
          </div>
          <div className="peer-files">
            <h2>Available on Network</h2>
            <ul>
              {Object.values(peerFiles).map((file) => (
                <li key={file.name}>
                  {file.name}{" "}
                  <button onClick={() => requestFile(file.name)}>
                    Download
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;
