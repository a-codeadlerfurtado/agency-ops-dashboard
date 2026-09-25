import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import NativeGate from "./NativeGate";
import { iniciarCamadaNativa } from "./lib/native";
import { ProvedorDeToasts } from "./ui";
import "./styles.css";

void iniciarCamadaNativa();

const raiz = document.getElementById("root");
if (!raiz) throw new Error("#root nao encontrado");

createRoot(raiz).render(
  <StrictMode>
    <NativeGate>
      <ProvedorDeToasts>
        <App />
      </ProvedorDeToasts>
    </NativeGate>
  </StrictMode>
);
