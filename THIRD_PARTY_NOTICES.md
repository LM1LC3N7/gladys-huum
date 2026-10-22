# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

Its Huum client (`src/huum/client.js`, the paths, status codes and
temperature range of `src/constants.js`) is a JavaScript port of parts of
**huum** 0.8.3 (<https://github.com/frwickst/pyhuum>), the Python library of
the Huum integration for Home Assistant: the `/action/home/` endpoints of
sauna.huum.eu (`status`, `start`, `stop`), the HTTP Basic authentication, the
`targetTemperature` payload, the status codes (230 to 233, 400), the
temperature range (40 to 110 °C), the fields of the status answer, and the
check that the door is closed before heating. No Python code runs here and
the library is not a dependency. It carries this license:

```
MIT License

Copyright (c) 2021 Frank Wickström

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The runtime dependency `@gladysassistant/integration-sdk` is installed from
npm with its own license.
