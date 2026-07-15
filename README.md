# TSKBattleLog

A battle log analyzer for Twinkle Star Knights using Frida and IL2CPP.

TSKBattleLog captures and analyzes battle events from the game runtime, including damage events, skill usage, and combat states. It also provides configurable auto-battle skill selection through `char_skill.json`.

## Features

- Real-time battle event logging
- Damage tracking and post-battle damage summary
- Skill usage tracing
- Unison damage tracking
- Combat state analysis
- Configurable auto-battle skill selection via `char_skill.json`

## Technical Notes

TSKBattleLog uses Frida and frida-il2cpp-bridge to hook IL2CPP methods at runtime and reconstruct battle events.

The project observes game runtime behavior by tracing relevant methods and converting internal battle data into readable logs.

## Installation

Install dependencies:

```bash
npm install
```

## Usage

Start the game, then run the provided PowerShell script:

```powershell
.\run.ps1
```

The script will:

* Build the Frida agent using `npm run build`
* Attach the agent to the running game process
* Save runtime logs to the `logs` directory

Log files are generated with timestamps:

```
logs/
└── 20260716_001234.log
```

## Configuration

`char_skill.json` can be used to configure skill selection rules during auto battle.

Example:

```json
{
    "星を見るもの":2,
    "バニーサンタ":1,
    "夏色マジカル☆":0
}
```

Configuration values:

- `2`: Automatically use EX2 if the current EX gauge is enough to pay the EX2 skill cost.
- `1`: Automatically use EX1 if the current EX gauge is enough to pay the EX1 skill cost.
- `0`: Never use any EX skill automatically.

The configuration controls the skill priority used by the auto-battle system.

## Disclaimer

This project is intended for research, analysis, and personal customization purposes.

Some features involve modifying battle-related data and may affect game behavior. Use at your own risk.

## Credits

Thanks to [TSKHook-frida](https://github.com/TSKModding/TSKHook-frida) for providing a valuable reference for Frida and IL2CPP runtime analysis.