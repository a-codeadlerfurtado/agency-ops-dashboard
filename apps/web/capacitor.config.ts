import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.imobiboard.crm",
  appName: "ImobiBoard",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 700,
      launchAutoHide: true,
      backgroundColor: "#030b14",
      showSpinner: false,
    },
    StatusBar: {
      style: "DARK",
      backgroundColor: "#030b14",
      overlaysWebView: false,
    },
  },
};

export default config;
