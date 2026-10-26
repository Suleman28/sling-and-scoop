# Plan: "Dispatch" — low-poly helicopter rescue/cargo game (browser)

## Resolved decisions (Phase 1)
- **Name:** *Rotor Relay* (island: unnamed for now). Chaining dispatches = the relay; avoids "Dispatch", which is an existing game title.
- **Map:** one main island (~1.8 km across, bays + central ridges) plus three islets, on a 2.8 km square terrain with 10 m cells (157k tris, one draw call). Fixed map seed `1337` so the career island stays learnable.
- **Daily seed:** yes for v1, but it drives the *shift* (incident director, wind), not the terrain. Lands in Phase 4.
- **Palette:** warm dusk. Low sun over the sea, peach horizon to indigo zenith, teal water, olive/ochre grass, mauve rock. Chopper is cream/teal with an orange fin so it never blends with fire.
- **Controls:** WASD/arrows pitch and turn, Q/E strafe, Space/Shift collective, M mute. The action key moves from E to **F**, since E is taken by strafe.

## Context
Brainstorm output to hand to Opus 5.5 (Max effort) for implementation. Goal: a fun, addictive, original browser game. Chosen direction: a **helicopter service game** (firefighting, cargo, rescue) that blends an **endless "shift" loop** (escalating chaos, roguelite-style upgrades) with an **open-world sandbox career** (free-roam island map, mission board, money, hangar). Flight is arcade/physics-lite. Greenfield project, no existing code.

## Why it's addictive (design pillars — build around these)
1. **10-second learnability, deep mastery.** Tilt+thrust arcade flight. Skill comes from *load physics*: water sloshing in the bucket, cargo swinging on the line, wind gusts.
2. **Always something burning.** A live world simulation generates problems; the player triages. Never an empty moment, never a long loading screen.
3. **Chaining.** Finishing a mission within a window of the previous one builds a dispatch combo multiplier (money + score). Greed vs. safety is the core tension.
4. **Shift structure over the open world.** A "shift" is a 5–8 min run: chaos meter rises as unattended incidents pile up; shift ends when it maxes. Payout feeds a persistent career (money, unlocks), so every failure still progresses ("one more shift").
5. **Visible upgrade ladder.** Every shift ends with a purchase you can almost afford next: bucket size, winch length, rotor power, fuel, new airframes, cosmetic liveries.
6. **Juice.** Flat-shaded low-poly + great feedback: rotor wash on water/trees, smoke columns, steam when water hits fire, screen shake on hard landings, satisfying coin/combo audio.

## Originality angle (not a clone)
- Unique mix: **fire-spread simulation + swinging sling-load + chained dispatch combos** in one loop. Not a Crazy-Taxi/Choplifter/Firefighter-sim copy.
- Incident types share one tool set (bucket, winch hook, passenger bay) so one chopper does everything; upgrades specialise it.

## Core gameplay
**Incidents (spawned by a director, scaled by shift time):**
- Wildfire: grid-based cellular spread (wind-biased, fuel by terrain type: forest > grass > rock). Dip bucket in water, dump on flames. Unattended fires grow and threaten buildings.
- Cargo delivery: hook crate with winch, carry swinging load to a pad; fragile/timed variants.
- Rescue: hover-winch stranded hikers/boaters or land to pick up passengers, drop at hospital.
- Later unlocks: power-line repair crews, ship supply drops, sling-lifting wrecked vehicles, storm evacuation.

**Systems:**
- Fuel + fast refuel pad (adds light resource management; refuelling is also a risk/reward timing choice).
- Weather: wind direction/strength (affects flight, fire spread, load swing), occasional storm event.
- Money (career) and Score (shift). Heat/chaos meter drives shift end.
- Hangar: upgrades + airframes (light scout, medium utility, heavy lifter) with different handling/capacity.

**Controls (arcade):** WASD / arrows = pitch & yaw-turn, Space/Shift = collective up/down, Q/E = strafe, F = action (dip/dump/hook/release), mouse optional for camera. Gamepad support via Gamepad API. Touch: virtual stick + two buttons (stretch goal).

## Tech approach (keep it lean)
- **Three.js** + **Vite**, TypeScript optional (plain JS acceptable). No physics engine: hand-rolled arcade integration + a simple pendulum for the swinging load + a damped-spring "slosh" value for water. No asset pipeline: **all models procedural** (primitives / merged flat-shaded geometry).
- Terrain: procedural heightmap (simplex noise from a seed), flat-shaded, vertex-coloured by biome; water plane; chunk-free (single island/archipelago sized for 60 fps in browser).
- Fire sim: low-res grid (e.g., 64×64) updated at fixed tick, rendered with instanced cones/particles.
- Audio: WebAudio synthesis (rotor loop pitched by throttle, bucket splash, UI blips). No audio files.
- Persistence: `localStorage` save of money, upgrades, best scores, seed.
- Single `index.html` + a few modules; deploy as static files. Performance budget: 60 fps on integrated GPU, < 5 MB total.
- Dev-time self-checks: one small test for the fire-spread step and one for the pendulum/load integration (determinism with a seeded RNG).

## Build phases (each ends playable)
1. **Fly**: scene, terrain, water, chopper model, arcade flight, chase camera, fixed-timestep loop. *Gate: flying feels good alone.*
2. **Tools**: bucket dip/dump with slosh; winch hook with swinging load; fuel + refuel pad.
3. **Incidents**: fire sim + wildfire mission; cargo and rescue missions; mission board + markers/arrows HUD.
4. **Shift loop**: incident director, chaos meter, combo chain, results screen, money payout.
5. **Career meta**: hangar upgrades + 3 airframes, save/load, unlock progression.
6. **Juice & polish**: particles, wind/weather, day/night tint, audio, screen shake, tutorial in first shift, settings (invert, volume), gamepad/touch.
7. **Balance & ship**: tune spawn rates/upgrade costs for ~3 shifts before first big unlock; perf pass; static deploy.

## Open decisions for Opus to resolve while building
- Exact map size/layout (one island vs. small archipelago) within perf budget.
- Whether daily seeded shift (shared leaderboard-less, same seed per day) is in v1 — recommended as cheap, high retention.
- Name/branding and colour palette (suggest a warm dusk palette with saturated fire/water contrast).

## Verification
- Run `vite` dev server; manually play: fly, dip/dump on a fire, hook and deliver a crate, finish a shift, buy an upgrade, reload and confirm persistence.
- Run the two self-checks (fire-spread determinism, pendulum stability).
- Profile in browser DevTools: steady 60 fps, no GC spikes during fire sim.
- Check keyboard and gamepad input; verify layout at a phone-width viewport if touch is included.
