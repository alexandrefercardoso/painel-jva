if (typeof window !== "undefined" && import.meta.env.PROD && "serviceWorker" in navigator) {
  console.log("Attempting to register SW...");
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      console.log("SW registered: ", registration);
    })
    .catch((registrationError) => {
      console.error("SW registration failed: ", registrationError);
    });
}
