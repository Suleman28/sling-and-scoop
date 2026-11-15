# Plan: "Dispatch" — low-poly helicopter rescue/cargo game (browser)



## Before open-sourcing (decide later)
- **Name:** decided: *Sling & Scoop* (see Resolved decisions). Domain: slingandscoop.com if free; .game was too pricey.
- **License:** MIT (simplest, recommended), Apache 2.0 or GPL 3.0. `public/sfx/airplane_prop.wav` stays under CC BY 3.0 with its credit.
- **README banner:** state plainly that this is an experimental project built with AI coding agents (Claude and Gemini Argon), not a production game.
- **Repo housekeeping:** a short CONTRIBUTING note pointing to AGENTS.md (the conventions and the `inspect.html` model check) and `npm test`.

## Post-deploy updates (planned)
- **Damage and repairs:** the damage meter and base repair shipped in Phase 9. Still planned: a maintenance workshop island project to halve the repair price (its model, `workshop` in world.js, is built and viewable in inspect.html).

## Resolved decisions (Phase 12: expanded harbour, ships, offshore oil rig, cutter & bomber overhauls)
- **Expanded harbour & living vessels:** added fishing pier, marina finger slips, outer L-shaped breakwater, Container & Ferry Pier, and a separate Coastguard & Rescue Station wing (`world.js`), with full `SOLIDS` and `boatEnv` collision. Added `MV Heron` (container ship) and `SS Meridian` (passenger ferry) via `buildShip(variant)` (`ship.js`, `life.js`): both berth clear of the main quay, turn in open water outside the pier, back cleanly into berth, carry wakes (`makeWake`), show on the map with tapered silhouettes, and have solid/landable decks (`shipSolids`, `deckAt`, `boatEnv`).
- **Offshore Oil Rig:** detailed `OILRIG` (`world.js`) with K-braced jacket, conductor pipes, boat landing, 3-storey quarters, orange lifeboat, pedestal crane, lattice derrick, flare boom, and an `H` helideck (`deckAt`, `SOLIDS`, `boatEnv`), plus offshore fire/rescue calls (`missions.js`), longer boat mission durations, vessel route clearance, and an `Offshore refuel` island project (`career.js`).
- **Rescue Cutter anchor & upgrades:** added dock mooring/auto-moor and ocean anchor (`KeyR`) with a visibly mounted starboard bow hawsepipe anchor, lowering chain animation, and smooth `anchorDrop`/`anchorWeigh` audio (`boat.js`, `audio.js`, `main.js`). Added `Monitor pumps` and `Thrusters & helm` upgrades (`career.js`).
- **Water Bomber & chopper flight overhaul:** updated `buildPlane` (`plane.js`) with upward dihedral, leading-edge de-ice boots, wingtip winglets, animated belly drop doors and scoop probes, and livery detail; updated `stepPlane` with control inertia, bank/airspeed lift, idle/scoop drag, `R` Salvo/Trail toggle, and `High-flow scoops` / `Flaps & control surfaces` upgrades (`career.js`). Improved helicopter pitch-coupled thrust and carving (`chopper.js`) and smoothed `"Physics flight"` rope-joint feedback and winch retraction (`physics.js`). Optimized `makeWake` (`fx.js`) and vessel frustum culling (`life.js`) for steady 60+ fps.

## Resolved decisions (Phase 11: missions overhaul, living island)
- **Menus are morphed, not rebuilt.** Every overlay write goes through `render(html, screen)`. A new screen replaces the content and plays its entrance; the same screen again is morphed (`morph`), so only changed nodes are touched: no flicker, no replayed animation, scroll kept. `data-keep` protects nodes built in code (the hangar showroom canvas); `data-fresh` forces a replace when its value changes (a new hangar message, a settings tab), so it plays its entrance. The in-flight board and meter use the same patching (`patch`). One easing curve (`--ease`) and press, hover and fill transitions throughout; all motion is off under `prefers-reduced-motion`.
- **The cutter fights boats, not land.** Shoreline fires burned out before she could get there, so her fire calls are vessels on fire at sea (`j.vessel`, `heat` 1 → 0). Her monitors' water puts them out (`douseAt`, from `splash`). Untended, the heat creeps back up, and after `SHIFT.vesselBurn` she's lost.
- **Patients and clinics.** Casualties have a `severity`, and their condition (`cond`) falls over time (serious ~4 min, minor ~8 min); pay scales 0.4–1 with it. A minor case's destination is the nearest town clinic, with the hospital as `alt` (+25%).
- **Calls near you.** `nearPick` puts half the new calls near your position, so a second job on the way is common.
- **Light work.** Passengers between towns and urgent medicine (a parcel, collected by landing or with the hook). They're about 45% of rescue calls for aircraft without a hook (the Scout) and 18% otherwise. Aircraft that can't fight fires get fire-spotting calls instead (type `spot`): fly over the smoke for 2 s, and the ground crews put it out (`extinguish` in fire.js).
- **Hook and cutter rescues.** Swimmers in a rip off a beach (from Line Pilot) and climbers on a cliff you can't land on (from Senior Pilot, hook only).
- **Pilot ranks** (`RANKS`, `rankOf`, `career.xp` = gross pay earned):
  - Trainee: small wildfires, light cargo, ordinary rescues, passengers, medicine, spotting.
  - Line Pilot: house and car fires, car crashes, the freighter, rip rescues, night shifts.
  - Senior Pilot: large wildfires, heavy and volatile cargo, cliff and shipboard rescues.
  - Captain: major wildfires, foundering trawlers.
  - Old saves get XP from what they own. Rank shows on the title screen and the results screen, with a promotion line.
- **Night shifts** (from Line Pilot, a quarter of shifts, decided by the seed): pay +30%, dark fog, sky and light, searchlight on, a brighter lighthouse beam.
- **Daily challenge** (title key 5): the seed comes from the date (`dailySeed`), so it's the same shift for everyone; the best net per day is kept in `career.daily`.
- **Shift report:** the results screen draws your route (sampled every 2 s) and a dot where each job finished.
- **Scars heal.** Scorched ground and trees regrow halfway each shift (`resetScorch(houses, regrow)`) instead of resetting. Visual only: fuel isn't reduced.
- **Living harbour** (`life.js`): a trawler that leaves its berth, goes out to sea and comes back; a fuel truck on the base–harbour road (`fuelTruck`, in inspect.html). The lighthouse beam has two arms.

- **Phase 10b fixes and features.**
  - **Bomber:** no searchlight. The chase camera leans by `sin(roll)`, since `s.roll` keeps counting past 2π through a barrel roll and used to leave the view tilted or upside down.
  - **Cutter monitors:** range follows the camera pitch (`s.jetK`, 0.3–1, range ∝ k²): look down for ~10 m, level for ~100 m. The physics push uses the same arc. Holding F stops the camera drifting back. L switches the cutter's searchlight too.
  - **Line gear:** the Utility ships with the hook only; its bucket is a $2,500 kit (`AIRFRAMES.utility.gear`, `career.gear`, `buyGear`, `toolsOf`, hangar key G). Fire calls need a bucket, and old saves that own a Utility keep theirs. R cycles bucket, hook, then stowed (no line at all).
  - **Moored cutter:** she lies at her berth, riding the swell, whenever you aren't sailing her. She's scenery only.
  - **Big map (M; mute moved to K):** the minimap's layers at 560 px with place names, labelled calls and a legend.
  - **Islet hamlets:** Northcay and Gull Rock are towns (`SITES`, `islet: true`). They're off the road network and wildfires don't start there (the islets are too small), but cargo, rescues and house fires do.
  - **Harbour road:** the harbour's shore end is a road-network node, so a road runs from the base gate to the jetty. `HARBOUR` is computed before the roads now.
  - **Two jobs at once (`MAX_JOBS`).** `d.jobs` holds them and `d.job` is the one in focus (beacon, compass, objective text); J cycles it (`cycleFocus`). Pickups and deliveries run on every taken job, so a second casualty near the first can board too. The job not in focus gets a faint beacon. X hands back the focused job.
  - **Cutter aim ring** follows the throw (`s.jetK`) and shrinks for short throws.
- **Low-poly is the game's identity.** A smooth, shader-textured terrain was tried (noise detail, bump lighting, rock streaks) and dropped: it looked generic and halved the frame rate. Instead the terrain went HD low-poly:
  - 5 m cells (`SEGS = 560`, ~627k triangles), crisp facets (85% face normal).
  - Each cell is split along the diagonal whose corners are closer in height (`flip(i, j)`), so facets fold along ridges and valleys. `heightAt` and the Rapier trimesh use the same rule, so contact stays exact.
  - Colour is picked from the smoothed slope at a triangle's corners, so both halves of a square agree (the old per-triangle normal made slopes checkered).
  - Rock is two-tone blotches, not stripes. A snowcap covers the gentle high ground above `snowLine(x, z)` (~125–170 m), and nothing burns above it (`fuelAt`). Scorch handles `TREE_CELL / CELL` terrain cells per fire cell.
  - Same GPU cost per frame as the old 10 m terrain on the dev Mac; still to be tried on an integrated GPU (7 m cells is the fallback).
- **Waterjet wake and surface foam (`fx.js`).** Earlier hard-edged foam streaks faded to black under normal blending and drew under the water.
  - `makeRings` is now soft additive foam blobs, drawn after the water and lifted 0.1 + 0.15 × `SEAS.h` above the swell (the 35 m water facets sag below `waveAt` in troughs).
  - `makeWake` builds the cutter's wake from crumbs dropped along her track: twin jet streams that merge and fade, a bow wave hugging the hull that breaks into patchy Kelvin-arm whitecaps (0.34 × speed sideways), and a churning foam plume per nozzle that steers with it and boils forward under the reversing buckets.
  - The nozzle steering sign was fixed: D swings the jets to starboard.
- **Soft particles.** Smoke, dust, spray and fire puffs are camera-facing discs with fading edges (`puffGeometry` + `billboard` in `fx.js`), not flat hexagons; debris keeps low-poly chunks (`soft: false`).
- **Crashes.**
  - Severity scales the blast (20 m/s gives 0.5, 42 m/s and up the full 1.6).
  - A helicopter's main rotor is torn off and flung, then lands and skids to a stop (`throwRotor`); the craft is rebuilt on the tow.
  - A wreck in the sea ditches: splash and steam, no fire, and it floods and sinks (the wreck's draft grows in `physics.js`).
  - **Respawn bug fixed:** `spawnCraft()` now clears `wreck`, `damage`, `hit`, `crashV`, `ditched`. It's copied over the old state, so a towed wreck used to come home still wrecked and burning.
  - Dynamic rollover was considered and left out: ground roll only follows the slope, and >37° already bounces you off.
- **Harbour, physics and warm-dusk pass (an earlier Gemini session, verified here).**
  - The harbour rebuild (`harbour()`, `inspect.html?model=harbour`) was checked from all 7 views. It has a stone quay, timber walkway and T-head, piles, a landing stage, a boathouse, a refuel point, a davit crane and festoon lights.
  - Rapier gained pier colliders, a third drum stack on the pier head (23 drums), swell-slope drift for floating bodies, an oriented cutter hull collider, and jet, thruster and monitor wash on floating things. Helicopters on the freighter's deck turn with her (`SHIP.dYaw`).
  - Water and shore: deeper water colours, turquoise shallows, a foam outline at the beach, shore-parallel surf bars, lit windows, warmer clouds and ambient boats.
  - Not done, despite the claims in the earlier notes: `waveAt` is still the original two sines, and there is no tone mapping, no sun shimmer and no shadow map (the `castShadow` flags are inert).
- **Cutter.** Twin waterjets replace props and rudders. Q/E bow and stern thrusters crab her sideways, and A/D pivots her at rest. She slides along walls (step obstacles) instead of pinning. A stall going ahead in an astern crosswind is fixed. All are covered in `test/boat.check.js`.

## Resolved decisions (Phase 9: cutter, weather, damage, solid world)
- **The Rescue Cutter replaces the dinghy** (same `AIRFRAMES.boat` key, `boat: true`; $9,000, not the old $3,000). A 21 m fire and rescue cutter (~13.5k triangles) is the one deliberately fine model, an owner-requested exception to the low-poly budget: it is the showpiece of the harbour and only one is ever on screen. It takes sea rescues and shoreline fires (`d.sea()`), so the water has a job for a vehicle that is not an aircraft.
- **Monitors are aimed with the mouse.** The monitors and searchlight follow the camera yaw (`s.aim`), F sprays, G is the horn. The camera is already how you look around, so aiming costs no extra keys and leaves W/S/A/D free for driving.
- **Weather.** A squall every ~5 minutes lasting ~1.5, driven by one `weather.storm` 0..1 value: wind with gusts, sea state (`SEAS.h` up to 3), fog, dimmer light, rain, lightning with delayed thunder. One scalar keeps wind, water and sky in step and costs no new systems. Lightning can start fires; on shift it becomes a "Lightning strike near …" call, so a storm creates work as well as hazard.
- **Damage and repair.** Hits over 6 m/s accumulate `s.damage` (below the 20 m/s `CRASH`): it costs engine power (`env.power`), smokes, and at 100% is a wreck. It is repaired by stopping at base ("Repairing…", `COSTS.repair`); a wreck costs `COSTS.crash`. This is the visible meter the earlier silent end-of-shift charge lacked (HUD shows HULL).
- **Volatile cargo.** "Fuel drums" and "Gas bottles" pay more but explode on a hard knock (`VOLATILE` in `missions.js`, `d.blast`): no pay and the combo is lost. Gives the existing drum explosions a risk/reward use in the job board.
- **Buildings are solid for everything.** `SOLIDS` boxes in `world.js` feed both the loose-body colliders in Rapier and a pushed-out check in `hitTrees`, so aircraft and slung loads hit houses too (before, only loose things did). Aircraft stay hand-rolled against the static world, as with trees.
- **Water is one function.** `waveAt(x, z, t)` scaled by `SEAS.h` drives the water mesh, floating bodies, the cutter (pitch and roll) and buoys; crests are vertex-coloured, so whitecaps appear in a blow without a texture. Shoreline foam (`buildSurf`), dusk lights (`buildLights`) and a recoloured seabed (so the terrain's square edge no longer shows) are cosmetic.
- **Harbour and life.** `HARBOUR`/`buildHarbour` puts a timber jetty nearest the base as the cutter's home (refuel, hangar). Dolphins, channel and hazard buoys and trawlers are decoration only (`life.js`).
- **Minimap, cockpit view, shift grade.** The minimap (bottom right: island, fires, pads, calls, objective, you) answers "where is the call" without opening anything. V toggles a cockpit camera (no interior model yet). The results screen grades the shift S to D from net pay minus losses, to give a target beyond the number.
- **Not done:** the cutter passes through the jetty and breakwater (only the seabed stops it); rain does not change fire spread; no cockpit interior; all Phase 8 and 9 tuning values need a hands-on play-test. Multiplayer stays as proposed in Phase 8.

## Resolved decisions (Phase 8: sim layer, boat, harbour)
- **"Feels like a sim, plays like an arcade game."** The stick still commands a velocity and neutral collective still holds a hover, so nothing has to be trimmed. On top of that sit real helicopter behaviours that only bite when you fly badly, each with a HUD line saying how to get out: vortex ring state, rotor spool-up, autorotation with a flare, fuel weight, sprung skids, slope landings and fire thermals. Vortex ring needs ~2.5 s of full vertical descent above 10 m, so an ordinary landing never meets it.
- **Rescue Boat (now the Rescue Cutter, Phase 9).** A third vehicle kind (`boat: true`) beside helicopter and plane, kinematic in Rapier like the bomber, so it shoves floating drums and cargo. It only takes sea rescues and lands them at the harbour jetty; fire and cargo stay with aircraft. Originally a cheap ($3,000) dinghy; the cutter costs $9,000.
- **One swell.** `waveAt` in `world.js` is the water mesh's own wave function; floating bodies and the boat ride it (plus a small chop), so things sit on the water you can see.
- **Multiplayer (not built; proposed shape).** Co-op first: 2–4 pilots on one shift, shared chaos meter and board, each in their own craft. The repo already deploys to Cloudflare, so a Durable Object per room relaying over WebSocket fits without a new client dependency. Each client simulates its own craft and sends pose at ~15 Hz; the room host's client owns the director, fire grid and loose physics and sends events and snapshots (the fire sim and director are already seeded and deterministic). Needs deciding before any code: co-op vs competitive, who is host, and whether a server-side dependency (`wrangler`/Durable Objects) is acceptable under the "no dependencies" rule.

## Resolved decisions (Phase 7: physics engine)
- **The loose world reacts (second pass).** The engine was simulating boxes nobody had a reason to touch, so the pass is about consequences rather than more flight modelling; `stepFlight` is unchanged.
  - Water: loose bodies skip the sea-floor collider and float by a per-load `draft` with drag and a small swell; vehicles ride low, casualties' rafts sit on top. Things going in report a splash.
  - Oil drums are explosive: a jolt over `DRUM.pop` (ramming, a dropped load, a swung bucket) or burning ground sets one off. A blast is a radial impulse capped per body, short random fuses on drums within `DRUM.chain` (so a pile ripples rather than vanishing in one frame), and an `ignite` on the fire grid, so a careless pilot can start the wildfire they then have to fight. Piles are restacked at the start of each shift.
  - Downwash is a radial force on drums and non-person loads under a low rotor; people are left out because a side force topples their thin box.
  - Buildings are static boxes from `SOLIDS`. Wrecks explode, burn and smoke for 5 s before the tow.
  - `physics.step` returns events and `main.js` owns all the effects, so `physics.js` stays renderer-free apart from the drum mesh.
- **Flight physics (hybrid), on by default; Settings → "Physics flight" switches back to the classic model.**
  - The controls are unchanged: `stepFlight` still turns the stick into a velocity. The helicopter is then a dynamic Rapier body (no gravity, rotation locked). Rapier adds what the world does to it, and `stepFlight` eases back toward its target, so knocks linger. It collides only with loose things; ground, cliffs and trees stay hand-rolled (probes, reflect).
  - The rope is a Rapier rope joint (rebuilt when the winch changes its length) to a real bucket/hook ball or to the hooked load's own body. The rotor carries the load's weight up to `RIG.maxLift`; beyond that the load pulls the craft down and holds it. Load inertia is real: a container roughly halves how fast you can accelerate. Water, slosh and attitude rocking are shared with the classic rig (`settleRig`).
  - An impact over `CRASH` (20 m/s) turns the aircraft (helicopter or bomber) into a tumbling box with gravity. The load drops and it's towed home after 5 s (3 s for running out of fuel). Hillsides and trees at speed now crash where they used to bounce.
  - The bomber flies as before: its state is speed along a direction, so it stays kinematic until it wrecks.
  - Node checks cover the classic flight and rig unchanged, plus the physics path (`physics.check.js`: hover on the rope, lift, overload, ram-and-wreck).
- **Rapier (`@dimforge/rapier3d-compat`) runs the loose world, not the flight.** The goal is to push what a browser game can do, so the original "no physics engine" rule is lifted for world objects. Helicopter, plane and rope stay hand-rolled so the flight feel and `npm test` are unchanged.
  - Free loads (crates, heavy cargo, casualties) are dynamic boxes (`RIG[...].box`): they tumble, roll and stack. A load on the hook is kinematic and shoves what it swings into; the aircraft is a kinematic ball that bulldozes loose things without feeling them.
  - Colliders: the terrain's own triangles, a floor at sea level, a cone per tree, and a cylinder per tower. Houses were added later (`SOLIDS`, Phase 9).
  - Oil-drum pyramids (one instanced mesh) on the base apron and at the islet depot, there to be knocked over.
  - `c.hit` is now each step's change in velocity, so tree strikes, drops and getting rammed all count as rough handling.
  - Lazy-loaded: the WASM chunk is ~1.6 MB gzipped. Until it's ready (and in node checks) loads use the old `stepCrate`. Step cost ~0.4 ms; the one-off ~50 ms broad-phase build happens during load.
  - Multiplayer later: physics must stay off the flight model so a host can own the world bodies and stream them.

## Resolved decisions (Phase 6c: island projects, hangar)
- **Island projects** ($45k in total), bought in the hangar with keys A–E. They're built into the world, so you can see what you bought:
  - Town refuel stations, $9k: refuel at any town pad.
  - Base dip tank, $6k: a raised open tank at base the bucket can dip in, so no trip to the sea.
  - Fuel farm, $12k: fuel bills −40%.
  - Fire lookout towers, $18k: three ridge-top towers; new wildfires start as a single cell, without their seed patch.
- **Discounts live in the bills:** `fuelBill` and `repairBill` in career.js. `career.projects` is saved, and old saves load with none.
- **Hangar:** a detailed arched hangar replaces the box-and-half-cylinder: corrugated cladding, roof rib bands, sliding doors, an office annex and floodlights.
- **Overlay:** it scrolls when its content is taller than the screen (`place-content: safe center`).

## Resolved decisions (Running costs)
- **Shifts net less than they gross.** `COSTS` in `career.js`; bills via `fuelBill(career, kind, amount)` and `repairBill(career, kind, hit)` (they take `career` so island projects can discount later). Shift net = earned − fuel − repairs − losses, banked by `recordShift(c, earned, costs)`; best shift is on net; the bank may go slightly negative (never blocks flying).
  - Fuel $ per full tank: scout 150, utility 350, heavy 700, bomber 800. Charged as the tank fills on pads/strip (shown in the refuel prompt); free roam is free.
  - Repairs: $12 per m/s of impact above 3 m/s, times class (scout 0.6, utility 1, heavy 2, bomber 2.2). Only the airframe's own `s.hit` counts, summed per frame, billed at shift end.
  - Losses: $150 smashed fragile cargo, $200 casualty hurt by a rough set-down.
  - Target: ~20% of a typical ~$2.5k Utility gross when careful (about 1.3 tanks, a few small bumps), 35%+ when crashing (each 14 m/s crash is about $130, plus losses).
## Resolved decisions (Settings screen)
- **Settings** (key 4 on the main menu, 3 when paused; Esc/Back returns to where it was opened): a frozen 'settings' mode. The controls list moved off the HUD into its first section (keycap table: Helicopter, Water Bomber, General); the `#help` line is now an option, off by default, and a one-time "Esc: pause · Settings for controls" prompt shows at the first shift or free roam. Options (master volume, look sensitivity, invert Y, show FPS, show hint) persist in localStorage `rotorRelay.settings`. Keydown ignores keys while an input is focused (except Esc). Volume sits under the M mute.

## Resolved decisions (Phase 6a: menus, free roam, living island)
- **Per-airframe upgrades (economy pass):** `career.levels[airframe][upgrade]`, 5 levels each; buying applies to the airframe you're flying. Only applicable rows show: Scout power/fuel; Utility and Heavy all four; Bomber water (tank)/power/fuel. Old shared-levels saves are copied to every owned airframe (clamped). Airframe prices Utility 5k, Heavy 14k, Bomber 22k (was 4k/10k/15k).
  - Base cost per level (L1..L5) times the class multiplier (Scout 0.6, Utility 1, Heavy 1.8, Bomber 2.2), rounded to $50: water 400/800/1300/1800/2200, line 250/500/800/1100/1350, power 500/1000/1600/2200/2700, fuel 350/650/1100/1500/1900.
  - Full upgrade: Scout $8,050; Utility $24,000 (4.8x price); Heavy $43,250 (3.1x); Bomber $44,000 (2.0x). Whole fleet about $160k including purchases (was about $57k).
  - Per level: water +16%, line +1.8 m, thrust +5%, climb +7%, load slowdown -12%, lift +0.1, fuel +20% (was +30%, +2.5 m, 7%, 10%, 20%, 0.15, +30%).
- **Storylines (missions v3):** every incident is step 1 of a short story and finishing a step posts the next one at the top of the board straight away (`story`/`followUp` in `missions.js`). Crash: casualty to hospital, then the wreck to base (the crash car prop stays as the wreck until it's hooked). House fire: out, displaced family to another town, building materials there. Wildfire: out, groceries/water tanks to the town. Car fire: out, burnt-out wreck to base. Hiker: sometimes a friend nearby. Supplies to the hospital: then a patient transfer out to a town. Plain cargo, boaters, transfers and heavy contracts stay single-step. Steps the airframe can't do (`d.can`, or heavy cargo above `RIG.maxLift`) are dropped when the story is created, so the Scout never gets the wreck and the bomber never gets relief runs. Stories live at once are capped at 2 (3 after 150 s); follow-ups don't count. A follow-up taken straight after its parent pays +25% (`SHIFT.followBonus`) on top of the chain multiplier; the chain window opens on finish as before. Abandon (X) returns the step to the board and breaks the chain. Casualties now carry a `dest` (hospital by default).
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
- **Name:** *Sling & Scoop* (renamed from the working title *Rotor Relay*; repo `sling-and-scoop`). It names the two core jobs, cargo on the hook and water in the bucket. Considered: Downwash, Hotshot Isle. Avoid "Dispatch" (a big 2025 game), "Longline" (an itch.io helicopter game) and "Ember Isle" (taken). localStorage keys keep the old `rotor-relay` names so saves survive. Hosted on Cloudflare (static assets from `dist/` via `wrangler.jsonc`, `NODE_VERSION=22`).
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
