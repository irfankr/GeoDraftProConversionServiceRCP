FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 20 and X11/GL stubs needed by CloudCompare's Qt runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates wget \
    libglib2.0-0 libgl1 libxrender1 libxext6 libx11-6 libxi6 libxkbcommon-x11-0 \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# CloudCompare AppImage — extracted in-place (no FUSE needed).
# The official AppImage includes the QRDB_IO plugin (RCP/RDB reader) which
# is not always present in distro packages.
RUN wget -q "https://github.com/CloudCompare/CloudCompare/releases/download/v2.13.2/CloudCompare_v2.13.2-Qt5.15.3-64bit.AppImage" \
    -O /tmp/cc.AppImage \
    && chmod +x /tmp/cc.AppImage \
    && cd /tmp && ./cc.AppImage --appimage-extract \
    && mv /tmp/squashfs-root /opt/cloudcompare \
    && rm /tmp/cc.AppImage

# Wrapper: bundle the AppImage's Qt/GL libs and force offscreen rendering
RUN printf '#!/bin/sh\nexport LD_LIBRARY_PATH=/opt/cloudcompare/usr/lib:$LD_LIBRARY_PATH\nexport QT_QPA_PLATFORM=offscreen\nexec /opt/cloudcompare/usr/bin/CloudCompare "$@"\n' \
    > /usr/local/bin/CloudCompare \
    && chmod +x /usr/local/bin/CloudCompare

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY index.js ./

CMD ["node", "index.js"]
