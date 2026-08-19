if (typeof window !== "undefined" && "serviceWorker" in navigator) {
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
