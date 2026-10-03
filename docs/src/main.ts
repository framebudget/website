import "./tokens.css";
import "./site.css";
import "./setup";
import { mountChart } from "./chart";
import { mountDock, mountSoundToggle } from "./dock";
import { mountEffects } from "./fx";
import { preloadMotion } from "./motion";
import { mountHome } from "./sim";
import { mountSound } from "./sound";

mountSound();
mountSoundToggle();
mountDock();
mountChart();
mountHome();
mountEffects();
preloadMotion();
