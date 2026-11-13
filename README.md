# The Impossible Casino

A 1920s casino built inside a quantum computer, where each room is a game whose odds are set by quantum rules. The headline is the Impossible Tables: no plan agreed in advance can win over time, an entangled pair can, and a real IBM chip did.

- **Play:** https://impossible-casino.vercel.app
- **Demo video:** https://youtu.be/qewpLcwSFQM

Built for the VT Qiskit hackathon. Every quantum number in the game comes from Qiskit. Each result is labeled with where it came from: the live Qiskit simulator, a pre-run Qiskit simulator (ideal or IBM noise model), or a named IBM chip with its job ID. The claim is not speed. The headline claim, made only for the Tables, is beating a proven classical limit in a game. The Cage and the Roulette Wheel show other quantum limits that you can measure, and the house still wins at both.

## What's new here
- **A quantum advantage with a price on it.** The CHSH game and Wiesner money are standard textbook examples. This project makes them bets. The house pays 25 on 100 at the Tables, so break-even is 80%, between the classical 75% and the quantum 85.36%. A classical player loses money over time, and an entangled one wins. The house edge is how a casino prices an advantage, so it is a natural way to show one.
- **An original quantum game.** The Roulette draft is new: players take turns placing gates on a 5-qubit wheel. Qiskit solved its value exactly, 1 in 4 against a perfect house, and found a trap: sweeping the wheel at once looks best, but it lets the house halve your odds.
- **Provenance you can play with.** Every result opens a receipt with its circuit, source and job ID. A chip run that came out wrong for the game is shown and explained, not hidden.

## The rooms

### The Impossible Tables (the CHSH game)
You and a partner each get a random question and answer without talking. You win if your answers fit a simple rule.

- **Without entanglement:** no plan agreed in advance wins more than **75%** of hands. This is found by brute force over every deterministic strategy.
- **With an entangled pair:** you can reach **85.36%** (Qiskit statevector at the best dial setting).
- **The house** pays 25 on a 100 stake, so you break even at 80%. Classical play loses money over time. Entangled play wins.

You lose at the 75% wall, entangle, turn the dial to find the winning angles, then stake each run. When you beat 75%, the seal shatters.

### The Cashier's Cage (Wiesner quantum money)
The bank prints notes on qubits. You play a forger who measures each qubit in a guessed basis and re-makes it. Against this attack, each qubit passes with chance 3/4, so a note of *n* qubits passes (3/4)^*n* of the time. That figure is this attack's exact rate, not a bound on every possible attack. Pick a length from 1 to 8 and a stake, then forge.

### The Roulette Wheel
Five qubits make 32 pockets. You and the house take turns playing cards from a shared deck: Sweep (a Hadamard on every qubit), Spin (on qubit 0) and Tie (a CZ on qubits 1–2 or 3–4). Then the wheel spins.

- Qiskit solved all 360 legal drafts exactly (statevectors plus minimax). Against a perfect house, the best you can force on one pocket is **1 in 4**.
- Measure the wheel between cards and it is left fully mixed, so every pocket stays at **1 in 32** whatever is played. The gain comes from keeping the superposition across turns.
- A straight-up bet pays 280 on 100: a 5% house edge at the 1-in-4 limit.

## Results from real IBM hardware

All runs used `ibm_kingston`. The qubits were the best-case pick from that day's calibration, and the receipt for each result names them.

| Room | Job ID | What ran | Result |
| --- | --- | --- | --- |
| Tables | `dbnneo0qtr0c73adbufg` | CHSH at 9 dial settings, 4,096 shots per question pair | Peak **84.48% ± 0.28%** at the middle setting: 33.5 standard errors past the 75% classical limit, and past the 80% break-even. CHSH S = 2.76 (classical bound 2, quantum limit 2.83). At that setting: ideal simulator 85.32%, noise model 84.80%. |
| Cage | `dbnp35gou4as73b4tusg` | Wiesner forgery, lengths 1 to 8, 128 random notes × 8 shots each, with mid-circuit measurement | Pass rate against exact: 78.2% vs 75.0% at length 1, 27.8% vs 31.6% at 4, 9.6% vs 10.0% at 8. Lengths 1 and 2 are within sampling spread of the exact rate. |
| Roulette | `dbns0f5t7fqc73ak4isg` | All 108 reachable drafts on 5 qubits, 116,736 shots | **Not used in play.** On the chip, the wheel leans toward pocket 0, so one draft would beat the house. The game plays the IBM noise model instead, and labels it that way. |

Earlier pilot runs are kept in `quantum/chip_runs/` with their job IDs (`dbnna5gqtr0c73adbo90`, `dbnoi58ou4as73b4tcr0`).

## What I learned
- **Hardware noise can do more than blur a result.** On the chip, the Roulette wheel leaned toward one pocket, enough to give the player an edge the math forbids. The honest fix was to show it and play the noise model, not to re-run until it looked right.
- **Error bars need the right model.** The Cage replays each random note for several shots, so the shots are not independent. Naive error bars came out too tight; clustering by note gives honest ones.
- **Near a limit, the sample matters.** At one qubit the chip passed 78.2%, but those 128 particular notes were expected to give 78.1%, so the chip did not beat 75%.
- **Design for failure first.** Pre-run exports, then the live simulator, then the chip: the site never breaks when the backend is down.

## How it fits together

```
quantum/   Qiskit circuits, exports and chip runs (Python)
   │  exports results to JSON
   ▼
web/public/data/*.v1.json   pre-run results, shipped with the site
   │
web/       TypeScript, Three.js, Vite, Web Audio
   │  asks for live runs, falls back to the exports
   ▼
api/       FastAPI on Google Cloud Run: live Qiskit Aer runs
```

- **Physics stays in Python.** TypeScript only looks up, samples and animates results that Qiskit produced. It never works out the physics itself.
- **The live API is optional.** The site plays fully from the exported results if the API is asleep, down or removed, and the source label says so. Live runs are noisy Aer simulations that use IBM's `fake_kingston` calibration. A chip button exists but is owner-only and capped. See [`api/README.md`](api/README.md).
- **Receipts and the math.** Every result opens a paper casino marker with the real circuit, source, shots and job ID. An optional "The math" sheet has the derivations and charts with error bars.
- **Sound** is synthesized live in the browser and is off until you turn it on.
- **Devices:** desktop first, playable on phones with lower graphics settings, and a flat table when WebGL is unavailable.

## Reading the code
- `quantum/chsh.py`, `wiesner.py`, `roulette.py`: the circuits and the limits, each with a docstring explaining the game.
- `quantum/export_*.py` and `quantum/chip_*.py`: the simulator exports and the chip runs, with full provenance.
- `web/src/game/`: game rules and result lookup (`results.ts` parses the exports, `store.ts` runs the game).
- `web/src/ui/receipt.ts` and `expert.ts`: the receipts and the math sheet.
- `api/main.py`: the live Qiskit service and its spending guards.

## Run it locally

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/), and Node 22 or newer.

**Web (plays from the exported results):**

```sh
cd web
npm install
npm run dev        # http://localhost:5173
npm test
```

**Quantum code and tests:**

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r pyproject.toml --extra dev
.venv/bin/python -m pytest quantum/tests
.venv/bin/python -m quantum.export_chsh --help    # likewise export_wiesner, export_roulette
```

**Live API (optional):**

```sh
uv pip install --python .venv/bin/python --no-deps -r api/requirements.lock
uv pip install --python .venv/bin/python 'httpx==0.28.1'
.venv/bin/python -m uvicorn --factory api.main:create_app --port 8081
cd web && VITE_API_URL=http://localhost:8081 npm run dev
```

The hosted API was shut down after judging. The public site now plays only from the pre-run exports, so it has no backend and costs nothing to run. Deploying, settings and costs are in [`api/README.md`](api/README.md).

## Built with
Qiskit 2.6, Qiskit Aer 0.18, Qiskit IBM Runtime 0.51, FastAPI, Google Cloud Run, TypeScript, Three.js, Vite and Web Audio.
