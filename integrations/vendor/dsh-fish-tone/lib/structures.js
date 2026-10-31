// Read-only sentence-pattern definitions from dsh-fish-tone.
export const FRAMES = [
  { id: 'not-but', name: '不是X而是Y', tier: 'strict', per1k: 0.06, re: /不是[^。！？]{1,24}(?:，\s*(?:这|那|它|就)?是|而是)/g },
  { id: 'most-de', name: '最…的是', tier: 'strict', per1k: 0.05, re: /最[^，。]{1,8}的是/g },
  { id: 'first-then', name: '先…再…', tier: 'strict', per1k: 0.01, re: /先[^，。]{1,10}再/g },
  { id: 'notonly', name: '不仅…更', tier: 'strict', per1k: 0.01, re: /不仅[^，。]{1,12}(?:更|还)/g },
  { id: 'de-copula', name: 'X的是Y', tier: 'soft', per1k: 0.37, re: /[^的，。！？]{1,8}的是[^，。]/g },
  { id: 'triple', name: '三段并列', tier: 'soft', per1k: 0.23, re: /[^，。、]{2,8}、[^，。、]{2,8}、[^，。、]{2,8}/g },
  { id: 'emdash', name: '破折号', tier: 'soft', per1k: 0.22, re: /——+|—/g, fix: 'comma' },
  { id: 'yue', name: '越…越', tier: 'soft', per1k: 0.16, re: /越[^，。]{1,8}越/g },
  { id: 'really', name: '真正/本质上', tier: 'soft', per1k: 0.17, re: /(?:真正|本质上|归根结底)/g },
  { id: 'roadmap', name: '首先/其次/综上', tier: 'soft', per1k: 0.5, re: /(?:首先|其次|综上所述|总而言之)/g },
]
