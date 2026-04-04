import { useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

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
      setError("Пожалуйста, заполните все поля");
      return false;
    }

    if (formData.email.length < 5 || !formData.email.includes("@")) {
      setError("Введите корректный email адрес");
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
          setError("Сервер не вернул токен доступа");
          return;
        }

        localStorage.setItem("token", accessToken);
        if (response.data.refresh_token) {
          localStorage.setItem("refresh_token", response.data.refresh_token);
        }

        CHAT_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));

        navigate("/chat", { replace: true });
      }
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { detail?: string } | string } };
      const errorMessage =
        typeof axiosErr.response?.data === "string"
          ? axiosErr.response.data
          : axiosErr.response?.data?.detail || "Ошибка при входе. Попробуйте позже.";
      setError(errorMessage);
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
            <label htmlFor="password">Пароль</label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              placeholder="Введите пароль"
              disabled={loading}
            />
          </div>

          <button type="submit" className="submit-button" disabled={loading}>
            {loading ? "Вход..." : "Войти"}
          </button>
        </form>

        <p className="auth-link">
          Нет аккаунта? <Link to="/register">Зарегистрироваться</Link>
        </p>
      </div>
    </div>
  );
}
