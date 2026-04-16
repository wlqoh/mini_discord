import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { extractApiError } from "../services/apiError";
import { getValidAccessToken } from "../services/authToken";

import API from "../api";
import "../index.css";

interface LoginFormData {
  email: string;
  password: string;
}

interface LoginResponse {
  access_token?: string;
  refresh_token?: string;
  token?: string;
  user?: {
    first_name?: string;
    last_name?: string;
    email?: string;
  };
}

const CHAT_STORAGE_KEYS = [
  "chat_servers",
  "chat_channels_by_server",
  "chat_selected_server_id",
];

export default function Login(): React.JSX.Element {
  const navigate = useNavigate();

  const [formData, setFormData] = useState<LoginFormData>({
    email: "",
    password: "",
  });

  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (getValidAccessToken()) {
      navigate("/chat", { replace: true });
    }
  }, [navigate]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const { name, value } = event.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    setError("");
  };

  const validateForm = (): boolean => {
    if (!formData.email || !formData.password) {
      setError("Please gap all fields.");
      return false;
    }

    if (formData.email.length < 5 || !formData.email.includes("@")) {
      setError("Please enter a valid email address.");
      return false;
    }

    return true;
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const response = await API.post<LoginResponse>("/login", {
        email: formData.email,
        password: formData.password,
      });

      if (response.status === 200) {
        const accessToken = response.data.access_token ?? response.data.token;
        if (!accessToken) {
          setError("The server did not return an access token.");
          return;
        }

        localStorage.setItem("token", accessToken);
        if (response.data.user) {
          localStorage.setItem("current_user", JSON.stringify(response.data.user));
        }
        if (response.data.refresh_token) {
          localStorage.setItem("refresh_token", response.data.refresh_token);
        }

        CHAT_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));

        navigate("/chat", { replace: true });
      }
    } catch (err: unknown) {
      setError(extractApiError(err, "Error logging in. Try again later."));
      console.error("Login error:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-container">
      <div className="auth-card">
        <h1>Вход</h1>

        {error && <div className="error-message">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="user@example.com"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Enter password"
              disabled={loading}
            />
          </div>

          <button type="submit" className="submit-button" disabled={loading}>
            {loading ? "Entering..." : "Login"}
          </button>
        </form>

        <p className="auth-link">
          Don't have an account? <Link to="/register">Sign Up</Link>
        </p>
      </div>
    </div>
  );
}
