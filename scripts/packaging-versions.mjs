export const WINDOWS_ARCHES = Object.freeze(['x64', 'arm64']);

export const TUNNEL_CLIENT = Object.freeze({
  version: 'v0.0.12',
  targets: Object.freeze({
    x64: Object.freeze({
      upstreamArch: 'amd64',
      sha256: '2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356'
    }),
    arm64: Object.freeze({
      upstreamArch: 'arm64',
      sha256: '65ab54221554481bb1c23b6015b99abe0b7f79b08593f4fb17a9e2e25532281d'
    })
  })
});

export const RIPGREP = Object.freeze({
  version: '15.2.0',
  targets: Object.freeze({
    x64: Object.freeze({
      upstreamArch: 'x86_64',
      sha256: '71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5'
    }),
    arm64: Object.freeze({
      upstreamArch: 'aarch64',
      sha256: 'e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f'
    })
  })
});
