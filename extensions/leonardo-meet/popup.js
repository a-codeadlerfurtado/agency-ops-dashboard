const statusEl = document.getElementById("status");
const pendingEl = document.getElementById("pending");
const settingsButton = document.getElementById("settings");
const retryButton = document.getElementById("retry");

async function render() {
  const result = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
  if (!result?.paired) {
    statusEl.className = "status bad";
    statusEl.textContent = "Este Chrome ainda não está conectado ao Dashboard.";
  } else if (result?.state?.active) {
    statusEl.className = "status rec";
    statusEl.textContent = `REC · ${result.state.title || result.state.meeting_code || "Google Meet"}`;
  } else if (result?.state?.error) {
    statusEl.className = "status bad";
    statusEl.textContent = `Atenção: ${result.state.error}`;
  } else {
    statusEl.className = "status ok";
    statusEl.textContent = `Ativo para ${result.device?.owner_person || "este colaborador"}.`;
  }
  pendingEl.textContent = result?.pending_uploads ? `${result.pending_uploads} reunião(ões) aguardando reenvio.` : "Nenhuma reunião pendente de envio.";
}

settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "FLUSH_OUTBOX" });
  retryButton.disabled = false;
  await render();
});

render().catch((error) => {
  statusEl.className = "status bad";
  statusEl.textContent = String(error?.message || error);
});
