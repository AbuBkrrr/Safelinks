import React from "react";
import { GoogleLogin } from "@react-oauth/google";
import { api, setSession } from "./api.js";

// Renders Google's native sign-in button. On success, exchanges the Google
// ID token for a SafeLinks JWT and hands the result to `onSuccess`.
export default function GoogleAuthButton({ onSuccess, onError }) {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    return (
      <div style={{ fontSize: 11.5, color: "#999", textAlign: "center", padding: 8 }}>
        Google sign-in unavailable (no client ID configured)
      </div>
    );
  }

  return (
    <GoogleLogin
      text="continue_with"
      shape="rectangular"
      width="300"
      onSuccess={async (credentialResponse) => {
        try {
          const res = await api.googleLogin(credentialResponse.credential);
          setSession({ token: res.token, role: res.role, user: res.user });
          if (onSuccess) onSuccess(res);
        } catch (err) {
          if (onError) onError(err.message || "Google sign-in failed");
        }
      }}
      onError={() => onError && onError("Google sign-in failed")}
    />
  );
}
