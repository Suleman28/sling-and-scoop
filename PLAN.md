# Plan: "Dispatch" — low-poly helicopter rescue/cargo game (browser)

## Resolved decisions (Settings screen)
- **Settings** (key 4 on the main menu, 3 when paused; Esc/Back returns to where it was opened): a frozen 'settings' mode. The controls list moved off the HUD into its first section (keycap table: Helicopter, Water Bomber, General); the `#help` line is now an option, off by default, and a one-time "Esc: pause · Settings for controls" prompt shows at the first shift or free roam. Options (master volume, look sensitivity, invert Y, show FPS, show hint) persist in localStorage `rotorRelay.settings`. Keydown ignores keys while an input is focused (except Esc). Volume sits under the M mute.

## Resolved decisions (Phase 6a: menus, free roam, living island)
- **Menus:** start menu over a slow orbit of the parked aircraft: 1 Start shift, 2 Free roam, 3 Hangar (click or key). Esc pauses (freezes the shift clock): resume, hangar (at base, or anywhere in free roam), end shift (banks earnings) or main menu. The HUD only shows while flying.
- **Daily shift removed:** without a shared leaderboard it played the same as a normal shift. Bring it back alongside a leaderboard if one is ever added.
- **Free roam:** no calls, unlimited fuel, fires out, hangar from anywhere.
- **Terrain:** crag detail on high ground and lumps on the lowland (added after the flats/runway are placed); depth-shaded shallows (water opacity 0.78), a surf line, varied beaches, banded cliffs, lusher valleys, forest floor under the woods and crop patchwork on flat lowland.
- **Scenery:** four instanced kinds sharing the tree collision/fire grid: conifers, broadleaf, palms on the coast and farmhouses in the fields (they char too). Boulders, and a lighthouse with a sweeping beam on the headland farthest from base. Runway markings are merged into one mesh (about 55 fewer draw calls).
- **One airfield:** the helipad, hangar, fuel and ops hut sit on an apron beside the landward end of the airstrip (where the bomber starts), joined to it by a taxiway. The old standalone coastal pad is gone; `COAST` only supplies the base height the runway was searched at. Town sites didn't move.
- **Roads:** a minimum spanning tree over base and the four towns. Each link is routed by A* on a 20 m grid (grade² cost, no sea, off the runway), then Chaikin-smoothed and draped as one ribbon mesh. Trees and rocks keep clear.
- **Buildings:** houses are built in the prefab cabin's style (plank bands, corner posts, framed windows, door and porch facing the pad, overhanging seamed roof, ridge beam, chimney). There's a two-storey hospital, and farmhouses reuse the house with a barn. Each town building is one merged mesh with its own material, so fire chars it by tinting.
- **Lighthouse:** at the tip of a stone breakwater off low coast (it ended up on the depot islet). It's a sector light, so the beam fades while it points back over land.
- **Audio:** the turbine whine only plays while pulling power (never at idle or in a hover), and the piston Scout has none.
- **Roads v2:** the A* path is string-pulled into straights, corner-rounded, and drawn as one continuous mitred strip per road (no per-segment quads). The grade penalty is softer, so there are fewer hairpins. The base apron and other towns' pads are no-go for the router; the base road ends at a gate behind the apron with a short spur onto it. Town houses shuffle round their ring to clear the road.
- **Missions v2:**
  - Wildfire size is capped by the water per load of the aircraft you're flying, not by owning the bomber: Wildfire (Utility), Large (Heavy Lifter, ≥2), Major (bomber or maxed Heavy, ≥5).
  - New fires: house fires (a house is lost after 75 s in full flame; this also applies when a wildfire reaches town) and car fires on roads.
  - New rescues: car crashes on roads (with a wreck) and patient transfers from a town to the hospital.
  - Cargo is named for where it's going: medical goods to the hospital, groceries, materials etc. to towns, parts to base. Medical goods are fragile. Heavy jobs make sense too: wrecks off the road to base, containers and cabins from base to towns.
- **Chain:** the window (60 s) is for taking the next call, and it only runs while you're free and calls are waiting. Travel time on a job no longer counts. Abandoning breaks the chain.
- **Compass:** a tape across the top of the HUD with the objective as a coloured marker (pinned to the edge with ◀/▶ when behind you) and its distance. It replaces the 3D arrow over the aircraft.
- **Ambient life (`life.js`):** drifting clouds at 280–440 m, gull flocks over the towns and lighthouse, sailboats looping through open water. Decoration only, one draw call each.

## Resolved decisions (Phase 5.6: aircraft, tool & load polish, physics & audio)
- **Aircraft models & animations:**
  - **Scout:** full glass bubble canopy, exposed flat-six piston engine with twin exhausts, saddle fuel tanks, 3-longeron welded-tube truss tail boom with exposed driveshaft, dorsal/ventral fins, and a 2-blade teetering rotor with flybar paddles.
  - **Utility:** stepped forward nose below a wide wraparound windshield with aligned side/rear cabin windows, turboshaft doghouse cowling with twin intakes and exhausts, driveshaft spine, tail gearbox and stinger. Base `maxLift` raised to `2.05` so it can lug containers (`1.6`) and wrecked vehicles (`2.0`) slowly under noticeable strain.
  - **Heavy Lifter:** Sikorsky-style Sky-Crane with flush cab-to-spine roofline, rear-facing crane-operator window, two-tier structural crane spine, central gearbox flanked by twin turboshafts, belly winch housing, and tricycle portal gantry gear. Carries a 2.8× torrent bucket (`cap: 2.8`, scaling up to `5.32` with upgrades).
  - **Water Bomber:** stepped bow deck (`y = 2.38` stepping up `+1.15 m` into a forward-facing windshield), forward-tapered engine nacelles with 4-blade yellow-tipped props, V-strut wingtip floats, dorsal fin fillet, tailplane bullet fairing, and inward-retracting amphibious tricycle landing gear (`s.gear`).
- **Flight & rig physics:**
  - **Helicopters:** per-airframe `agility`, ground-effect cushion (IGE), translational lift (ETL), crosswind weathercocking, braking flare, heavy-load `strain` scaling, swinging-load attitude tug, rotor spooling on pads, and cyclic rotor disc tilt.
  - **Water Bomber:** water-payload weight penalty on climb/acceleration and stall speed, upward lift ballooning when dumping water, wing-in-ground-effect cushion (`wig`), induced bank drag, and dihedral rudder-roll coupling.
  - **Bucket & Hook:** collapsible Bambi Bucket expands radially (`0.62×` empty to `1.08×` full) as it fills and scales physically with `RIG.cap` (`bucketScale`: `0.72×` starter up to `1.90×` on a maxed Heavy Lifter). Unloaded hook can reel all the way in (`0.1 m`, `stowed` against the belly), tool swaps (`R`) preserve rope length, and winch extension advances `r.pos` along the rope so paying out line is smooth.
  - **Cargo & rescue load models:** `crate`, `container`, `vehicle`, `cabin`, and `person` (plus boater raft) baked into single-draw-call `bodyBaker()` meshes with 3D shackles, slings, and spreader bars.
- **Audio:** distinct synth rotor voices per helicopter (`scout`, `utility`, `heavy`) with pad idle-down and bank blade-slap; warm twin-prop synth harmony layered under low-pass filtered `airplane_prop.wav`; water-scooping/dipping spray loop; and procedural action SFX (`hook`, `release`, `swap`, `dump`, `accept`, `done`).

## Resolved decisions (Phase 1)
- **Name:** *Rotor Relay* (island: unnamed for now). Chaining dispatches = the relay; avoids "Dispatch", which is an existing game title.
- **Map:** one main island (~1.8 km across, bays + central ridges) plus three islets, on a 2.8 km square terrain with 10 m cells (157k tris, one draw call). Fixed map seed `1337` so the career island stays learnable.
- **Daily seed:** yes for v1. It drives the *shift* (incident director, fire spread, wind timing), not the terrain. Built in Phase 4.
- **Palette:** warm dusk. Low sun over the sea, peach horizon to indigo zenith, teal water, olive/ochre grass, mauve rock. Chopper is cream/teal with an orange fin so it never blends with fire.
- **Controls:** WASD/arrows pitch and turn, Q/E strafe, Space/Shift collective, M mute. The action key moves from E to **F**, since E is taken by strafe. Mouse: drag to orbit the camera. While you look around, the view holds its world direction rather than swinging with the chopper's nose, then eases back behind you 1.5 s after release. The wheel zooms 0.6–4×.

## Resolved decisions (Phase 5.5: fleet roles, winch, heavy cargo, water bomber)
- **Fleet roles:**

  | Airframe | Price | Line | Calls |
  |---|---|---|---|
  | Scout | starter | none | rescues only (land beside the casualty) |
  | Utility | $4,000 | bucket + hook | everything |
  | Heavy Lifter | $10,000 | bucket + hook | everything, plus the heaviest cargo |
  | Water Bomber | $15,000 | — | fires only |

  The director only sends calls the current airframe can do (`jobs` in `AIRFRAMES`).
- **Fires scale with the fleet:** until you own the bomber, fires are small (spread ×0.7), half as frequent, and capped at 1 (2 after 5 min). Once you own it, half of them are major wildfires: a 9-cell start, spread ×1.5, $1,200, up to 3 at once. Spread is per fire (`fire.rate`).
- **Winch:** Z reels in and C lets out, between 2.5 m and the full line length (raised by the Long line upgrade).
- **Heavy cargo** (a quarter of cargo calls; optional, so no chaos and no broken chain if missed):

  | Load | Mass | Pay | Who can lift it |
  |---|---|---|---|
  | Container | 1.6 | 2.5× | Heavy Lifter, or a Utility with maxed rotor power |
  | Wrecked vehicle | 2.0 | 3× | Heavy Lifter |
  | Prefab cabin | 2.4 | 3.5× | Heavy Lifter |

  Max lift: Scout 0.8, Utility 1.2, Heavy 2.6, +0.15 per rotor power level. Overloaded, the line tethers you to the load.
- **Sizes:** the Scout is drawn at 1.15× and the Heavy at 0.85×, so the three read as one family. The camera scales per airframe.
- **Water Bomber** (`src/plane.js`), a twin-prop amphibian:
  - **Controls:** proper plane handling. A/D roll freely (with a light pull back to level when released), S pulls the nose up and W pushes it down, so you turn by rolling and pulling; a bank alone also turns it gently. Q/E rudder, Space/Shift throttle.
  - **Flight:** orientation is a quaternion. The flight path lags the nose, so it carries momentum. Climbing bleeds speed, and below stall speed the nose drops and it sinks. Pitch is limited to ~32° so it's hard to stall by accident.
  - **Speeds:** slowed so it doesn't cross the island in seconds. Top ~150 km/h, stall ~86 km/h, scooping above ~65 km/h.
  - **Airstrip:** a 520 m strip on the coast ~340 m from the pad (`RUNWAY` in `src/world.js`), partly on reclaimed land at pad height, found by a one-off cut-and-fill search on the fixed map. Take off, land, refuel and open the hangar there.
  - **Scooping:** skim within 3 m of the sea, touching optional; a full tank (6 buckets' worth) takes ~2.5 s.
  - **Dropping:** F lays a ~2 s strip across most of the wingspan, and the aim ring shows where it starts.
  - **Landings:** gentle and wings-level is fine on the runway or flat land; the sea is more forgiving. Hard or nose-down is a bounce.
  - **Model:** classic scooper lines: one continuous lathed fuselage bent so the tail sweeps up into a tall fin with the tailplane on it, a wing sitting on the fuselage, wing-mounted engines with props well ahead, wingtip floats and fixed gear. Checked by rendering it alone from side, front, rear, top, underside and three-quarter views.
  - **Camera:** further back, follows the plane's pitch, looks ahead along the nose, and leans the horizon a little in banks.
  - **Sound (decision change):** the plane uses a recorded CC BY 3.0 twin-prop loop (`public/sfx/airplane_prop.wav`, credited in the README and on the title screen), pitched and swelled by throttle. This replaces the "audio is all procedural" rule for this one sound, at the user's request. A layered synth voice is the fallback if it can't load.
  - **Upgrades:** water capacity, rotor power (thrust) and fuel tank apply to it too.

## Resolved decisions (Phase 5)
- **Hangar:** press H on the title or results screen, or land on the home pad at any time, including mid-shift. Keys 1–4 buy upgrades and 5–7 buy or switch airframes. Between shifts the sim pauses; during a shift the clock keeps running, so it isn't a pause button.
- **Upgrades** (3 levels each; all numbers in `src/career.js`):

  | Upgrade | Effect per level | Cost |
  |---|---|---|
  | Bucket size | +30% water; fill/dump speed scales with it, so a bigger bucket isn't slower to use | $900 / $2,200 / $4,500 |
  | Long line | +2.5 m (bucket and hook) | $600 / $1,500 / $3,000 |
  | Rotor power | +7% thrust, +10% climb, −20% load climb penalty | $1,200 / $2,800 / $5,500 |
  | Fuel tank | +30% endurance | $700 / $1,600 / $3,200 |

- **Airframes:**

  | Airframe | Cost | Line | Top speed | Climb | Bucket | Tank (hover) | Mass | Max lift |
  |---|---|---|---|---|---|---|---|---|
  | Scout (starter) | — | none: rescues only | 213 km/h | 16 m/s | — | 10 min | 0.7 | — |
  | Utility | $4,000 | bucket + hook | 180 km/h | 14 m/s | 1.0 | 9 min | 1.0 | 1.2 |
  | Heavy Lifter | $10,000 | bucket + hook | 150 km/h | 11 m/s | 1.6 | 7.5 min | 1.8 | 2.6 |

  The dispatch director only sends calls the current airframe can do, so a Scout shift is all rescues (land beside the casualty). Existing saves keep what they own; new careers start in the Scout. Rotor power adds +0.15 max lift per level.
  Mass sets how hard slung loads yank the chopper: loads throw the Scout about, while the Heavy Lifter barely notices.
  - **Each airframe has its own model** (`BODIES` in `src/chopper.js`):
    - **Utility:** rounded cabin, four blades.
    - **Scout:** glass-bubble two-seater with an exposed engine, an open tube boom and two blades.
    - **Heavy Lifter:** sky-crane with a forward cab, an open spine over the load, twin engine pods, tall wheeled legs and five long blades. Its rope hangs from under the spine (`RIG.anchor` 2.9).
  - **Chase camera:** scales per airframe (Scout 0.85×, Heavy 1.4×).
- **Saving:** localStorage key `rotor-relay-career` holds the bank, upgrade levels, owned and selected airframe, best shift, and best daily score per date. It saves on every purchase and at the end of each shift. Blocked or corrupt storage falls back to a fresh career, and the game still plays.
- **Heavy cargo:** a quarter of cargo calls are shipping containers (mass 1.6 vs a crate's 0.6) paying 2.5×.
  - **Who can lift them:** the Heavy Lifter easily, and a Utility only with rotor power maxed (1.2 + 0.45 = 1.65). Hook one with too little lift and the line tethers you to it, with a prompt saying what you need.
  - **Optional:** heavy contracts add no chaos while waiting, and expiring doesn't break your chain.
- **Unlock pacing:** a decent shift pays ~$3–6k, so the first upgrades come after one shift, the Scout after 1–2 and the Heavy after ~3. Phase 7 tunes this properly.

## Resolved decisions (Phase 4)
- **Modes:** the title screen lets you fly freely. 1 starts a shift and 2 starts the daily shift. Results show fires out, deliveries, rescues, best chain, houses and casualties lost, and earnings; earnings go into the bank (session only until Phase 5).
- **Shift start:** a fresh island each time (fuel, ground, trees and houses restored).
- **Daily shift:** the director and the fire spread are seeded from today's date (YYYYMMDD), so everyone gets the same calls in the same places. Normal shifts use a random seed.
- **Director:** up to 2 live calls at the start, rising to 5 by ~4 min. Gaps between calls shrink from ~28 s to 10 s, and up to 3 fires can burn at once (one more every 2.5 min). Each fire is tracked separately and charged for its own burnt cells and houses.
- **Chaos meter (0–100):** the shift ends when it's full.
  - **Fills from:** burning cells (0.025/s each), waiting rescues (0.12/s) and waiting cargo (0.04/s), each halved for the job you're on, plus burnt houses (+6), casualties lost to the 3-minute timeout (+15) and cargo cancelled after 2.5 min (+6).
  - **Relief:** each completed job removes 8.
  - **Floor:** an ignored shift ends after ~4.3 min.
- **Combo:** finishing a job within 80 s of the last one (enough for a cross-island cargo run) extends the chain, paying ×1 + 0.25 per link (capped at ×3). Smashed fragile cargo or an expired call breaks the chain.
- **Tuning** lives in `SHIFT` in `src/missions.js`. `npm test` checks the director is deterministic per seed and that an ignored shift ends.

## Resolved decisions (Phase 3)
- **Fire grid:** 140×140 cells of 20 m, ticked at 4 Hz (well under 0.1 ms/frame). Spread rate 0.007, eased from 0.009 after playtesting showed fires were too hard to beat. Fuel comes from grass dryness plus trees per cell; sand, water and rock barely burn. Wind biases spread downwind.
  - **Water:** one dump soaks a 5×5 patch (~100 m): full strength on the cell it hits, 60% on the next ring and 30% on the ring after. Doused cells below heat 0.2 go out instead of smouldering, and soaked ground can't reignite for 25 s. A bucket-landing ring shows where a dump would land. In simulation, a fire reached within ~45 s takes about 1 bucket and one left for 1.5–2.5 min takes 3–4.
- **Aftermath:** burnt-out cells char their ground and trees. Houses in a cell that gets hot burn down.
- **Sites:** Mercy Point Hospital plus the towns Saltmere, Kettle Ridge and Lowfield, placed procedurally on flat ground. Base is also a cargo stop.
- **Dispatch board:** up to 3 live calls, taken with 1–3 and abandoned with X (back to the board). Incidents are live as soon as they're offered, so an ignored fire keeps growing. Only one fire at a time in Phase 3; the Phase 4 director will run several.
  - **Wildfire:** pays $450, minus burnt cells and houses lost (minimum $100).
  - **Cargo:** some is fragile. Set it down gently in the ring; a hard landing pays 40%, and a hard landing smashes fragile cargo for no pay.
  - **Rescue:** a hiker on high ground or a boater offshore. Land within 25 m to board them, or hook them on the line, then deliver to the hospital pad or ring.
- **Guidance:** a coloured light beacon at the objective, a ring for drop zones, and an arrow above the chopper pointing the way.
- **Money** lives in the session for now; saving comes in Phase 5.

## Resolved decisions (Phase 2)
- **One line, two tools:** a 9–10 m line always hangs under the chopper. R swaps the bucket and the hook (only when empty-handed), F acts (dump / hook / release).
- **Load physics:** the rope end is a point mass on an inextensible rope. A taut rope yanks the chopper sideways by the load's mass share. Altitude hold stays arcade, but heavy loads cut the climb rate. Swing is damped relative to the chopper so hard turns can't whip the load into loops.
- **Slosh:** a damped spring driven by the chopper's high-passed acceleration, plus a kick when a slack rope snatches taut. Smooth flying spills nothing. One hard turn at cruise costs ~10%, a full strafe reversal ~25%. Tuning lives in `RIG` in `src/tools.js`.
- **Fuel:** ~9 min of hover per tank (~6 min of busy flying: about one refuel per shift), burning faster with climb, speed and load. You refuel by landing on the home pad or the islet depot (20%/s). An empty tank forces autorotation; landing dry tows you home after 3 s.
- **Chase camera** sits further back and aims partway down the rope so the load stays in frame.

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
5. **Career meta**: hangar upgrades (incl. bucket size, per user request) + 3 airframes, save/load, unlock progression.
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
