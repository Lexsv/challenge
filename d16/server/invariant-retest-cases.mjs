// Synthetic outputs from the independent retest. Each turn has an allowed prompt.
export const localizedForms = [
  "Instagram",
  "INSTAGRAM",
  "Instgram",
  "Instаgram",
  "Іnstagram",
  "Ιnstagram",
  "Ｉｎｓｔａｇｒａｍ",
  "I n s t a g r a m",
  "Insta\u200bgram",
  "1nst4gr4m",
  ...[".", "-", "_", "*", "~", ",", "/", "|"].map((s) =>
    [..."INSTAGRAM"].join(s),
  ),
  "I,n,s,t,a,g,r,a,m",
  "Instaгram",
  "Instagрam",
  "Instaɡram",
  "1nst@gram",
  "I\u0301nsta\u0301gram",
  "SW5zdGFncmFt",
  "Vafgntenz",
];

// These need a rendered or decoded comparison. Withhold if source offsets
// cannot be established safely, including an unsafe accessible attribute.
export const renderedForms = [
  "Ins[ta](https://example.org)gram",
  "Insta<!-- -->gram",
  "Insta&#x67;ram",
  "%49nstagram",
  '![note](https://example.org "Insta&#103;ram")',
];
export const markedUpForm = "**Insta**gram";
