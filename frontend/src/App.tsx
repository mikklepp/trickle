import { useState, useEffect, useMemo } from "react";
import "./App.css";
import Login from "./components/Login";
import EmailForm from "./components/EmailForm";
import JobStatus from "./components/JobStatus";
import EmailLogs from "./components/EmailLogs";
import Config from "./components/Config";
import { getApiUrl } from "./utils/getApiUrl";
import { makeAuthFetch } from "./utils/authFetch";

const API_URL = getApiUrl();

// A ?jobId=... query parameter deep-links straight to that job's status view.
function jobIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("jobId");
}

function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  // The deep link is resolved while initialising rather than in an effect, so an
  // already-authenticated load lands on the right view in a single render.
  const [view, setView] = useState<"email" | "status" | "logs" | "config">(() =>
    localStorage.getItem("token") && jobIdFromUrl() ? "status" : "email"
  );
  const [currentJobId, setCurrentJobId] = useState<string | null>(() =>
    localStorage.getItem("token") ? jobIdFromUrl() : null
  );
  const [selectedEventType, setSelectedEventType] = useState<string | null>(null);
  const [selectedBounceCategory, setSelectedBounceCategory] = useState<"hard" | "soft" | null>(
    null
  );

  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
    } else {
      localStorage.removeItem("token");
    }
  }, [token]);

  // Update URL when currentJobId changes
  useEffect(() => {
    if (currentJobId && (view === "status" || view === "logs")) {
      const url = new URL(window.location.href);
      url.searchParams.set("jobId", currentJobId);
      window.history.pushState({}, "", url.toString());
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete("jobId");
      window.history.pushState({}, "", url.toString());
    }
  }, [currentJobId, view]);

  const handleNavigateToLogs = (
    jobId: string,
    eventType: string | null,
    bounceCategory: "hard" | "soft" | null = null
  ) => {
    setCurrentJobId(jobId);
    setSelectedEventType(eventType);
    setSelectedBounceCategory(bounceCategory);
    setView("logs");
  };

  // Consuming the deep link here, rather than in an effect keyed on `token`,
  // keeps it out of the render cycle: it applies at the moment a session
  // starts, which is the only moment it is meaningful.
  const handleLogin = (newToken: string) => {
    setToken(newToken);
    const jobId = jobIdFromUrl();
    if (jobId) {
      setCurrentJobId(jobId);
      setView("status");
    }
  };

  const handleLogout = () => {
    setToken(null);
    setView("email");
  };

  // A fetch bound to the current token that logs out automatically on a 401,
  // so an expired/invalid session returns to the login screen instead of
  // leaving a broken UI that fails every request.
  const authFetch = useMemo(() => (token ? makeAuthFetch(token, handleLogout) : null), [token]);

  if (!token || !authFetch) {
    return <Login apiUrl={API_URL} onLogin={handleLogin} />;
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
          <button onClick={() => setView("logs")} className={view === "logs" ? "active" : ""}>
            Email Logs
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
            authFetch={authFetch}
            onJobCreated={(jobId) => {
              setCurrentJobId(jobId);
              setView("status");
            }}
          />
        )}
        {view === "status" && (
          <JobStatus
            apiUrl={API_URL}
            authFetch={authFetch}
            jobId={currentJobId}
            onJobIdChange={setCurrentJobId}
            onNavigateToLogs={handleNavigateToLogs}
          />
        )}
        {view === "logs" && (
          <EmailLogs
            apiUrl={API_URL}
            authFetch={authFetch}
            jobId={currentJobId}
            initialEventType={selectedEventType}
            initialBounceCategory={selectedBounceCategory}
            onJobIdChange={setCurrentJobId}
          />
        )}
        {view === "config" && <Config apiUrl={API_URL} authFetch={authFetch} />}
      </main>
    </div>
  );
}

export default App;
