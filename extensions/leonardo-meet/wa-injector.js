(() => {
  const id = "relato-wa-call-main-script";
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.src = chrome.runtime.getURL("wa-call-capture.js");
  script.async = false;
  script.dataset.relato = "whatsapp-call";
  (document.documentElement || document.head).appendChild(script);
  script.addEventListener("load", () => script.remove(), { once: true });
})();
