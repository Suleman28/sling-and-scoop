# AGENTS.md — Rotor Relay

Context for AI coding agents working on this repo. Read this first, then `PLAN.md` (design + every resolved decision, newest first).

## What it is
A browser game: low-poly island air dispatch. You fly helicopters and a water bomber through short, escalating "shifts" (fight wildfires with a slung bucket or the bomber, sling cargo, rescue hikers/boaters), chain jobs for combo pay, and spend the bank in a hangar. Warm-dusk, flat-shaded look.

## Stack and hard rules
- **Three.js + Vite, plain JavaScript (ES modules).** No TypeScript, no framework, no physics engine.
- **Everything is procedural.** Models are built from Three.js primitives in code. No model/texture files. The only asset is one credited sound (`public/sfx/airplane_prop.wav`, CC BY 3.0). Don't add assets without asking, and credit anything you add in `README.md`.
- **Don't add dependencies.** `three` and `vite` are the only ones.
- **60 fps on an integrated GPU is a hard requirement.** Watch draw calls (~20 in normal play) and triangle counts.
- **Keep it small.** Match the surrounding code's comment density, naming and idiom. No speculative abstractions.
- **Don't change the flight/gameplay feel unless asked.** Model work should leave `npm test` passing.

## Run and verify
```sh
npm install
npm run dev            # game: http://localhost:5173/
                       # model viewer: http://localhost:5173/inspect.html?model=plane
npm test               # node self-checks: flight, rig, fire, shift, career, plane
npm run build          # static site in dist/
```
**Model changes are not done until you've looked at them in `inspect.html`.** Check every view (keys 1–7: side, front, rear, top, under, ¾ front, ¾ rear) and confirm every part actually touches what it attaches to: no floating wings, gaps at the tail, inverted cones or paper-thin fins. Past mistakes in exactly these spots are why this rule exists. Then fly the aircraft in the game to see it from the chase camera.

## File map (src/)
| File | What's in it |
|---|---|
| `main.js` | Loop (fixed 60 Hz sim + interpolation), input, camera, HUD, modes (title/shift/results/hangar), wiring |
| `world.js` | Terrain heightmap, trees, water, sky, pads, sites/houses, runway, fire fuel, scorching |
| `chopper.js` | Helicopter flight (`stepFlight`, `TUNE`) **and helicopter models** (`buildChopper`, `BODIES`), plus the shared model helpers |
| `plane.js` | Water bomber flight (`stepPlane`, `PLANE`) **and its model** (`buildPlane`) |
| `tools.js` | Rope/bucket/hook physics (`RIG`) **and load models** (crate, heavy cargo, person, bucket/hook/rope views) |
| `fire.js` | Cellular wildfire sim + flame/smoke rendering |
| `missions.js` | Dispatch director, jobs, chaos/combo, markers |
| `career.js` | Save data, upgrades, `AIRFRAMES` (stats, livery, camera distance, scale) |
| `fx.js`, `audio.js` | Pooled particles; synthesized audio + the prop loop |

## Model conventions (read before touching any model)
- **Units are metres.** The **local frame**: ground contact at **y = 0** (skid bottoms / wheel bottoms), **nose toward −z**, +x is right (starboard), +y up. The physics treats the object's origin as that ground point, so a model floating above or sinking below y = 0 will look wrong in-game.
- **Build static parts into one merged mesh** with `bodyBaker()` (in `chopper.js`): `b.add(geometry, color, x, y, z, per)`. `color` is a hex or `fn(x, y, z)` of each face's centre, which is how liveries and windows are painted. `per = 6` paints whole quads for clean edges on lathed hulls. Material: `MeshStandardMaterial({ vertexColors: true, flatShading: true })`. One draw call per moving piece; don't add separate meshes for static detail.
- **Helpers:**
  - `hull(b, profile, paint, y, z, width)`: lathed body along z; profile is `[radius, z]` from nose to tail.
  - `fin(b, pts, color, y, z, thick)`: flat swept fin, `pts` are `[back, up]`.
  - `strut(b, r, color, a, b)`: a cylinder from point a to point b.
  - Cylinders are built along y. To lay one along z use `.rotateX(Math.PI / 2)`; the geometry's **top (radiusTop) then points to +z, the back**. Get this wrong and cones end up inverted.
- **Helicopters** (`BODIES.scout | utility | heavy` in `chopper.js`): each body bakes its static parts and returns a spec that `buildChopper` uses for the moving bits. If you move geometry, keep the spec in sync:
  `{ rotor: { y, z, blades, length, chord }, tail: { x, y, z, size }, lights: { port, star, beacon, strobe } }`
- **Plane** (`buildPlane` in `plane.js`): its fuselage is one lathe bent upward toward the tail with `sweep(z)`, so the tail sweeps up without a separate boom. Props spin about z. It must return `{ group, beacon, strobe, spin(dt, power) }`.
- **Things tied to model geometry elsewhere.** Update these if the shape changes:
  - `AIRFRAMES[...]` in `career.js`: `scale`, `cam` (chase distance), `body`/`trim` colours, and `rig.anchor` (rope attach height: under the Heavy Lifter's spine it's 2.45).
  - `RIG` in `tools.js`: each load's `hang` (hook point to the bottom of the load) and `radius` must match its mesh. Load meshes have their **origin at the top (the hook point)** and hang down.
  - Collision is a simple sphere (radius 1.8, plane 2.5) and ground contact at the origin. Big visual changes to size may need these adjusted.
- **Palette:** warm dusk.
  - Liveries: Scout yellow/charcoal, Utility cream/teal, Heavy Lifter light grey/red, Water Bomber yellow/red.
  - Shared constants: `DARK` (0x2a2a32) for metal and rotors, `GLASS` (0x1f3346) for windows.
  - Orange accents (0xf2763a): rotor tips and the Utility fin.
- **Budget:** keep each aircraft to roughly a few thousand triangles. Low-poly, flat-shaded and chunky is the style; readable silhouettes beat detail.

## Workflow
- After model work: `npm test`, view the model in `inspect.html` from all 7 views, fly it in-game, then `npm run build`.
- Record notable design decisions in `PLAN.md` under the latest "Resolved decisions" section.
- Commit only when asked. Commits are signed via 1Password (the user may need to approve).
