import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ProvedorDeToasts } from "./ui";
import "./styles.css";

const raiz = document.getElementById("root");
if (!raiz) throw new Error("#root nao encontrado");

createRoot(raiz).render(
  <StrictMode>
    <ProvedorDeToasts>
      <App />
    </ProvedorDeToasts>
  </StrictMode>
);
