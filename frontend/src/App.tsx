import { useState, useEffect } from "react";
import "./App.css";
import Login from "./components/Login";
import EmailForm from "./components/EmailForm";
import JobStatus from "./components/JobStatus";
import Config from "./components/Config";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3000";

function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem("token"));
  const [view, setView] = useState<"email" | "status" | "config">("email");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
    } else {
      localStorage.removeItem("token");
    }
  }, [token]);

  // Check for jobId query parameter on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get("jobId");
    if (jobId && token) {
      setCurrentJobId(jobId);
      setView("status");
    }
  }, [token]);

  // Update URL when currentJobId changes
  useEffect(() => {
    if (currentJobId && view === "status") {
      const url = new URL(window.location.href);
      url.searchParams.set("jobId", currentJobId);
      window.history.pushState({}, "", url.toString());
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete("jobId");
      window.history.pushState({}, "", url.toString());
    }
  }, [currentJobId, view]);

  const handleLogout = () => {
    setToken(null);
    setView("email");
  };

  if (!token) {
    return <Login apiUrl={API_URL} onLogin={setToken} />;
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Trickle - Email Distribution</h1>
        <nav>
          <button onClick={() => setView("email")} className={view === "email" ? "active" : ""}>
            Send Email
          </button>
          <button onClick={() => setView("status")} className={view === "status" ? "active" : ""}>
            Job Status
          </button>
          <button onClick={() => setView("config")} className={view === "config" ? "active" : ""}>
            Config
          </button>
          <button onClick={handleLogout} className="logout">
            Logout
          </button>
        </nav>
      </header>

      <main className="app-main">
        {view === "email" && (
          <EmailForm
            apiUrl={API_URL}
            token={token}
            onJobCreated={(jobId) => {
              setCurrentJobId(jobId);
              setView("status");
            }}
          />
        )}
        {view === "status" && (
          <JobStatus
            apiUrl={API_URL}
            token={token}
            jobId={currentJobId}
            onJobIdChange={setCurrentJobId}
          />
        )}
        {view === "config" && <Config apiUrl={API_URL} token={token} />}
      </main>
    </div>
  );
}

export default App;
