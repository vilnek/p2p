// The fixed list of 256 emoji used for emoji codes (index = one byte).
// Version 1 of the list: NEVER reorder or change it, or everyone's emoji code changes.
// Rules used to pick them: one code point each, shown as emoji by default (no variation selector),
// easy to name out loud, nothing that may upset people.

export const EMOJI_256: readonly string[] = Array.from(
  "🐶🐱🐭🐹🐰🦊🐻🐼🐨🐯🦁🐮🐸🐵🐔🐧🐦🐤🦆🦅🦉🐺🐴🦄🐝🐛🦋🐌🐞🐜🦗🐢🦎🦖🦕🐙🦑🦐🦞🦀🐡🐠🐟🐬🐳🐋🦈🐊🐅🐆🦓🦍🦧🐘🦛🦏🐪🐫🦒🦘🐃🐂🐄🐎🐏🐑🦙🐐🦌🐕🐩🐈🐓🦃🦚🦜🦢🦩🐇🦝🦨🦡🦦🦥🐁🐀🦔🌵🎄🌲🌳🌴🌱🌿🍀🎍🎋🍃🍂🍁🍄🌾💐🌷🌹🥀🌺🌸🌼🌻🌞🌕🌙🌎🪐💫⭐🌟⚡🔥💥🌈🌊💧🍏🍎🍐🍊🍋🍌🍉🍇🍓🍈🍒🥭🍍🥥🥝🍅🥑🥦🥬🥒🌽🥕🥔🍠🥐🥯🍞🥖🥨🧀🥚🍳🥞🍟🍕🥪🌮🌯🥗🍝🍜🍲🍛🍣🍱🥟🍤🍙🍚🍘🍥🥮🍢🍡🍧🍨🍦🥧🧁🍰🎂🍮🍭🍬🍫🍿🍩🍪🌰🥜🍯🥛🍼☕🍵🥤⚽🏀🏈⚾🥎🎾🏐🏉🥏🎱🏓🏸🏒🥍🏏🥅⛳🏹🎣🥊🥋🎽🛹🛷🥌🎿🏆🥇🎪🎨🎬🎤🎧🎼🎹🥁🎷🎺🎸🎻🎲🎯🎳🎮🧩🚗🚕🚙🚌🚎🚓🚑🚒🚐🚚🚛",
);

if (EMOJI_256.length !== 256) throw new Error('emoji list must have 256 entries');
