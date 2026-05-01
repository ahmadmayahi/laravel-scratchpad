import { createApp } from "vue";
import { createPinia } from "pinia";
// CRITICAL: bootstrap Monaco before any editor mounts. Registers language
// contributions and pins the worker factory on `self.MonacoEnvironment`.
import "./monaco";
import "../styles/main.css";
import App from "../App.vue";

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
