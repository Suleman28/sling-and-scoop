# Sling & Scoop

A low-poly island air-dispatch game for the browser: fight wildfires, sling cargo and pull people out of trouble in escalating shifts, then spend your pay on upgrades, helicopters and a water bomber.

## Run

```sh
npm install
npm run dev     # http://localhost:5173
npm test        # self-checks: flight, rig, fire, shift, career, plane
npm run build   # static site in dist/
```

## Controls

**Helicopters:** W/S pitch · A/D turn · Q/E strafe · Space/Shift climb/descend · F action (dump / hook / release) · R bucket ↔ hook · Z/C winch in/out

**Water bomber:** Space/Shift throttle · W/S pitch (nose down/up) · A/D roll · Q/E rudder · F drop. Take off from the airstrip; skim the sea above ~65 km/h to scoop.

**Everywhere:** 1–5 take a call · X abandon the job · H hangar (title/results screen, the home pad or the airstrip) · mouse drag to look around · wheel to zoom · M mute · Esc pause

In game the same list lives under **Settings** (main menu or pause), along with volume, look sensitivity, invert Y, FPS and an optional on-screen controls hint (off by default). Arrow keys also fly.

## Credits

Everything is procedural (models, terrain, effects, most sound) except one recording:

- **Water bomber engine loop:** "airplane prop loop" by **AntumDeluge** ([OpenGameArt](https://opengameart.org/content/airplane-prop-loop)), edited from "Porter Prop plane Int.WAV" by **jakobthiesen** ([Freesound](https://freesound.org/s/188423/)). Both licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Converted to mono WAV, otherwise unmodified.
