import { createApp } from "vue";
import { createPinia } from "pinia";
import { router } from "./router";
import { installSessionGuard } from "./router/sessionGuard";
import App from "./App.vue";
import "./assets/styles/base.css";
import "./assets/styles/ui.css";
import "./features/workspace/workspace.css";
import "./features/forms/form-designer.css";
import "./features/forms/record-presentation.css";
import "./features/organization/organization.css";
import "./features/organization/access.css";
import "./features/quick-fill/quick-fill.css";
import "./components/shared/user-menu.css";

installSessionGuard(router);
createApp(App).use(createPinia()).use(router).mount("#app");
