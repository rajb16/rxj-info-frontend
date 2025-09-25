import { useEffect, useState } from "react";
import "./App.css";

// The backend server is running on port 5000
const API_URL = 'https://rxj-info-api.onrender.com';

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);

  // Fetch the list of files from the server when the component mounts
  useEffect(() => {
    fetchFiles();
  }, []);

  const fetchFiles = async () => {
    try {
      const response = await fetch(`${API_URL}/files`);
      const data = await response.json();
      setUploadedFiles(data);
    } catch (error) {
      console.error("Error fetching files:", error);
    }
  };

  const onFileChange = (event) => {
    setSelectedFile(event.target.files[0]);
  };

  const onFileUpload = async () => {
    if (!selectedFile) {
      alert("Please select a file first!");
      return;
    }

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const response = await fetch(`${API_URL}/upload`, {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        alert("File uploaded successfully");
        setSelectedFile(null); // Reset file input
        document.getElementById("file-input").value = null; // Clear the file input display
        fetchFiles(); // Refresh the file list
      } else {
        alert("File upload failed");
      }
    } catch (error) {
      console.error("Error uploading file:", error);
      alert("Error uploading file");
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Simple File Manager</h1>

        {/* File Upload Section */}
        <div>
          <input id="file-input" type="file" onChange={onFileChange} />
          <button onClick={onFileUpload}>Upload</button>
        </div>

        {/* File Download Section */}
        <div className="file-list">
          <h2>Available Files</h2>
          {uploadedFiles.length > 0 ? (
            <ul>
              {uploadedFiles.map((file, index) => (
                <li key={index}>
                  <a href={`${API_URL}/download/${file}`} download>
                    {file}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p>No files uploaded yet.</p>
          )}
        </div>
      </header>
    </div>
  );
}

export default App;
