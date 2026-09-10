const codeInput = document.getElementById("code");
const connectButton = document.getElementById("connect");
const status = document.getElementById("status");

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (result?.paired) {
    status.className = "ok";
    status.textContent = `Conectado a ${result.device?.owner_person || "seu perfil"}. Captura automática ativa.`;
  }
}

connectButton.addEventListener("click", async () => {
  const code = String(codeInput.value || "").trim().toUpperCase();
  if (code.length < 6) {
    status.className = "error";
    status.textContent = "Digite o código gerado no Dashboard.";
    return;
  }
  connectButton.disabled = true;
  status.className = "";
  status.textContent = "Conectando...";
  const result = await chrome.runtime.sendMessage({
    type: "PAIR",
    code,
    device_name: `${navigator.platform || "Chrome"} · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || "Chrome"}`,
  });
  connectButton.disabled = false;
  if (!result?.ok) {
    status.className = "error";
    status.textContent = `Não foi possível conectar: ${result?.error || "erro desconhecido"}`;
    return;
  }
  codeInput.value = "";
  await refresh();
});

refresh().catch(() => {});
