import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Register from "./pages/Register";
import Login from "./pages/Login";
import ChatPage from "./pages/ChatPage";
import { getValidAccessToken } from "./services/authToken";

function RequireAuth({ children }: { children: React.ReactElement }) {
  return getValidAccessToken() ? children : <Navigate to="/login" replace />;
}

function GuestOnly({ children }: { children: React.ReactElement }) {
  return getValidAccessToken() ? <Navigate to="/chat" replace /> : children;
}

function App() {
  return (
      <BrowserRouter>
        <Routes>
          <Route
              path="/"
              element={<Navigate to={getValidAccessToken() ? "/chat" : "/login"} replace />}
          />
          <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
          <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
          <Route path="/chat" element={<RequireAuth><ChatPage /></RequireAuth>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </BrowserRouter>
  );
}

export default App;
