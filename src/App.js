import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "simple-peer";
import io from "socket.io-client";
import "./App.css";

const API_URL = "https://rxj-info-api.onrender.com";

function App() {
  const [status, setStatus] = useState("Initializing...");
  const [myFiles, setMyFiles] = useState({});
  const [peerFiles, setPeerFiles] = useState({});

  const socketRef = useRef();
  const peersRef = useRef({});
  const fileChunksRef = useRef({});
  const myFilesRef = useRef(myFiles);
  myFilesRef.current = myFiles;

  const handleData = useCallback((data, peerID) => {
    if (typeof data === "string") {
      try {
        const message = JSON.parse(data);
        if (message.type === "file-list") {
          // This logic now correctly associates files with a specific peer
          setPeerFiles((prev) => ({ ...prev, [peerID]: message.files }));
        } else if (message.type === "file-request") {
          const file = myFilesRef.current[message.name];
          const peer = peersRef.current[peerID];
          if (file && peer) sendFile(file, peer);
        } else if (message.type === "file-done") {
          const fileName = message.name;
          const fileInfo = fileChunksRef.current[fileName];
          if (fileInfo) {
            const completeFile = new Blob(fileInfo.chunks);
            const url = URL.createObjectURL(completeFile);
            const a = document.createElement("a");
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            delete fileChunksRef.current[fileName];
          }
        }
      } catch (e) {
        console.error("Failed to parse JSON message:", e);
      }
    } else {
      const fileName = Object.keys(fileChunksRef.current).find(
        (key) => fileChunksRef.current[key].receiving
      );
      if (fileName) fileChunksRef.current[fileName].chunks.push(data);
    }
  }, []);

  // ================== FIX #1 STARTS HERE ==================
  // This function now contains the 'connect' event handler.
  const setupPeerEvents = useCallback(
    (peer, peerID) => {
      console.log(`LOG: Setting up events for peer ${peerID}`);

      // THIS IS THE KEY: We wait for the 'connect' event before sending any data.
      peer.on("connect", () => {
        console.log(`LOG: Connection to peer ${peerID} established!`);
        setStatus(`Connected to a peer! Ready to share.`);

        // Now that we are connected, send our current list of files.
        const fileList = Object.values(myFilesRef.current).map((f) => ({
          name: f.name,
          size: f.size,
        }));
        if (fileList.length > 0) {
          console.log(
            `LOG: Announcing my files to the newly connected peer ${peerID}`
          );
          peer.send(JSON.stringify({ type: "file-list", files: fileList }));
        }
      });

      peer.on("data", (data) => handleData(data, peerID));
      peer.on("error", (err) => {
        console.error(`ERROR: Peer ${peerID} error:`, err);
        // Future step: Add cleanup logic here.
      });
      peer.on("close", () => {
        console.log(`LOG: Peer ${peerID} connection closed.`);
        // Future step: Add cleanup logic here.
      });
    },
    [handleData]
  );
  // =================== FIX #1 ENDS HERE ===================

  // The useEffect from the previous step remains the same to ensure stable connections.
  useEffect(() => {
    const createPeer = (userToSignal, callerID) => {
      console.log(`LOG: Creating peer to connect to: ${userToSignal}`);
      const peer = new Peer({ initiator: true, trickle: false });
      peer.on("signal", (signal) =>
        socketRef.current.emit("sending signal", {
          userToSignal,
          callerID,
          signal,
        })
      );
      setupPeerEvents(peer, userToSignal); // Setup events right away
      return peer;
    };
    const addPeer = (incomingSignal, callerID) => {
      console.log(`LOG: Adding peer who signaled us: ${callerID}`);
      const peer = new Peer({ initiator: false, trickle: false });
      peer.on("signal", (signal) =>
        socketRef.current.emit("returning signal", { signal, callerID })
      );
      peer.signal(incomingSignal);
      setupPeerEvents(peer, callerID); // Setup events right away
      return peer;
    };
    socketRef.current = io(API_URL);
    socketRef.current.on("connect", () =>
      setStatus("Successfully connected to the signaling server!")
    );
    socketRef.current.on("all users", (users) => {
      users.forEach((userID) => {
        peersRef.current[userID] = createPeer(userID, socketRef.current.id);
      });
    });
    socketRef.current.on("user joined", (userID) => {
      peersRef.current[userID] = createPeer(userID, socketRef.current.id);
    });
    socketRef.current.on("signal received", (payload) => {
      peersRef.current[payload.callerID] = addPeer(
        payload.signal,
        payload.callerID
      );
    });
    socketRef.current.on("signal returned", (payload) => {
      peersRef.current[payload.id]?.signal(payload.signal);
    });
    return () => {
      if (socketRef.current) socketRef.current.disconnect();
      Object.values(peersRef.current).forEach((peer) => peer.destroy());
    };
  }, [setupPeerEvents]);

  // ================== FIX #2 STARTS HERE ==================
  // This function is now simpler.
  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // 1. Update our own state first.
    const updatedFiles = { ...myFilesRef.current, [file.name]: file };
    setMyFiles(updatedFiles);

    // 2. Create the new file list to be sent.
    const fileList = Object.values(updatedFiles).map((f) => ({
      name: f.name,
      size: f.size,
    }));

    // 3. Announce the *entire* updated file list to all peers that are *already connected*.
    console.log("LOG: Announcing updated file list to all connected peers.");
    Object.values(peersRef.current).forEach((peer) => {
      if (peer.connected) {
        peer.send(JSON.stringify({ type: "file-list", files: fileList }));
      }
    });
    e.target.value = "";
  };
  // =================== FIX #2 ENDS HERE ===================

  // Unchanged functions
  const requestFile = (fileName, peerID) => {
    fileChunksRef.current[fileName] = { chunks: [], receiving: true };
    const peer = peersRef.current[peerID];
    if (peer && peer.connected) {
      peer.send(JSON.stringify({ type: "file-request", name: fileName }));
    }
  };
  const sendFile = (file, peer) => {
    const chunkSize = 64 * 1024;
    let offset = 0;
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target.error)
        return console.error("Error reading file:", event.target.error);
      peer.send(event.target.result);
      offset += event.target.result.byteLength;
      if (offset < file.size) {
        readSlice(offset);
      } else {
        peer.send(JSON.stringify({ type: "file-done", name: file.name }));
      }
    };
    const readSlice = (o) => {
      const slice = file.slice(o, o + chunkSize);
      reader.readAsArrayBuffer(slice);
    };
    readSlice(0);
  };

  // We need to update the rendering logic to handle the new peerFiles structure
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
              {Object.entries(peerFiles).flatMap(([peerID, files]) =>
                (files || []).map((file) => (
                  <li key={`${peerID}-${file.name}`}>
                    {file.name}
                    {/* We pass peerID to know who to request from */}
                    <button onClick={() => requestFile(file.name, peerID)}>
                      Download
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      </header>
    </div>
  );
}

export default App;
