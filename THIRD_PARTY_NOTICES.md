# Third-Party Notices

ChatGPT Account Keeper is licensed under GNU AGPL-3.0-only. The AGPL does not replace the licenses of the independent components listed below.

Release packages include machine-readable SBOM files and preserve the license files supplied by Node.js and npm packages. Exact versions are recorded in `package-lock.json`, .NET project/build output, the release SBOM, and `build/runtime-versions.json`.

## Components distributed with the Windows application

| Component | Version | License | Source |
| --- | --- | --- | --- |
| .NET / NativeAOT runtime | 10.0 | MIT and upstream third-party notices | https://github.com/dotnet/runtime/tree/release/10.0 |
| Node.js | 24.11.1 | MIT and bundled third-party notices | https://github.com/nodejs/node/tree/v24.11.1 |
| mihomo | 1.19.29 | GPL-3.0 | https://github.com/MetaCubeX/mihomo/tree/v1.19.29 |
| Playwright Core | 1.61.1 | Apache-2.0 | https://github.com/microsoft/playwright/tree/v1.61.1 |
| better-sqlite3 | 13.0.3 | MIT | https://github.com/WiseLibs/better-sqlite3/tree/v13.0.3 |
| Avalonia | 12.0.5 | MIT | https://github.com/AvaloniaUI/Avalonia/tree/12.0.5 |
| VeloPack | 1.2.0 | MIT | https://github.com/velopack/velopack/tree/1.2.0 |
| SkiaSharp | 3.119.4 | MIT | https://github.com/mono/SkiaSharp/tree/v3.119.4 |
| HarfBuzzSharp | 8.3.1.3 | MIT | https://github.com/mono/SkiaSharp/tree/v3.119.4 |
| ANGLE Windows native assets | 2.1.27548.20260419 | BSD-3-Clause | https://github.com/AvaloniaUI/ANGLE |

The production Agent also includes the npm dependencies recorded in `package-lock.json`. Their declared licenses are MIT, ISC, BSD-3-Clause, or Apache-2.0. The installed `agent/node_modules` tree retains license and notice files supplied by those packages.

The exact mihomo GPL text and Node.js license bundle are installed under `licenses/`. Releases also attach the corresponding mihomo source archive. See `SOURCE.md` for source locations and build instructions.

## Notices for compiled .NET/native components

### .NET / NativeAOT runtime (MIT)

Copyright (c) .NET Foundation and Contributors.

The .NET runtime is distributed under the MIT permission and warranty terms reproduced in the Avalonia notice below. Its complete upstream third-party notices are maintained at https://github.com/dotnet/runtime/blob/release/10.0/THIRD-PARTY-NOTICES.TXT.

### Avalonia and related Avalonia packages (MIT)

Copyright (c) AvaloniaUI OÜ. All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### VeloPack (MIT)

Copyright © 2021 Caelan Sayler. Copyright © 2024 Velopack Ltd.

VeloPack is distributed under the MIT permission and warranty terms reproduced in the Avalonia notice above.

### SkiaSharp and HarfBuzzSharp (MIT)

Copyright (c) 2015-2016 Xamarin, Inc. Copyright (c) 2017-2018 Microsoft Corporation.

SkiaSharp and HarfBuzzSharp are distributed under the MIT permission and warranty terms reproduced in the Avalonia notice above.

### ANGLE Windows native assets (BSD-3-Clause)

Copyright 2018 The ANGLE Project Authors. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of TransGaming Inc., Google Inc., 3DLabs Inc. Ltd., nor the names of their contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Trademarks and services

Google Chrome, ChatGPT, OpenAI, GitHub, and other names are trademarks of their respective owners. Their mention describes interoperability only and does not imply endorsement, sponsorship, or affiliation. Use of any network service remains subject to that service's terms.

If a generated SBOM and this summary differ, the exact component files, lock files, and upstream license notices control.
