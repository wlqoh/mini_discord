import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import Register from "./pages/Register";
import Login from "./pages/Login";
import ChatPage from "./pages/ChatPage";
import { getValidAccessToken } from "./services/authToken";

function App() {
  const hasToken = Boolean(getValidAccessToken());

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={hasToken ? "/chat" : "/login"} replace />} />
        <Route path="/register" element={<Register />} />
        <Route path="/login" element={<Login />} />
        <Route path="/chat" element={hasToken ? <ChatPage /> : <Navigate to="/login" replace />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
