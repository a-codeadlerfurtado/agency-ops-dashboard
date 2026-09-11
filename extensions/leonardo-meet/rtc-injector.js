(() => {
  const id = "leonardo-meet-rtc-main-script";
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id;
  script.src = chrome.runtime.getURL("page-rtc-capture.js");
  script.async = false;
  script.dataset.leonardoMeet = "rtc";
  (document.documentElement || document.head).appendChild(script);
  script.addEventListener("load", () => script.remove(), { once: true });
})();
