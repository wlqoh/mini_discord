import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { extractApiError } from "../services/apiError";

import API from "../api";
import "../index.css";

type Status = "verifying" | "success" | "error";

export default function VerifyEmail(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [status, setStatus] = useState<Status>(token ? "verifying" : "error");
  const [message, setMessage] = useState<string>(
    token ? "" : "This verification link is missing a token."
  );
  const requested = useRef(false);

  useEffect(() => {
    if (!token || requested.current) {
      return;
    }
    requested.current = true;

    API.post("/verify-email", { token })
      .then((response) => {
        setStatus("success");
        setMessage(response.data?.message ?? "Email verified successfully. You can now log in.");
      })
      .catch((err: unknown) => {
        setStatus("error");
        setMessage(extractApiError(err, "This verification link is invalid or has expired."));
      });
  }, [token]);

  return (
    <div className="auth-container">
      <div className="auth-card" style={{ textAlign: "center" }}>
        {status === "verifying" && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⏳</div>
            <h2 style={{ marginBottom: 8 }}>Verifying your email…</h2>
            <p style={{ color: "var(--text-secondary, #a8b2d8)" }}>Please wait a moment.</p>
          </>
        )}

        {status === "success" && (
          <>
            <div style={{ fontSize: 56, marginBottom: 16 }}>✅</div>
            <h2 style={{ marginBottom: 8 }}>Email Confirmed!</h2>
            <p style={{ color: "var(--text-secondary, #a8b2d8)", marginBottom: 24 }}>{message}</p>
            <Link to="/login" className="btn btn-primary" style={{ display: "inline-block" }}>
              Go to Login
            </Link>
          </>
        )}

        {status === "error" && (
          <>
            <div style={{ fontSize: 56, marginBottom: 16 }}>❌</div>
            <h2 style={{ marginBottom: 8 }}>Verification Failed</h2>
            <div className="error-message" style={{ marginBottom: 24 }}>{message}</div>
            <p className="auth-link">
              <Link to="/login">Back to Login</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
