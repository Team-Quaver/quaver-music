# Quaver loong RPM。electron-builder 不支持 loong64，payload 由 CI 组装后交给本 spec。
# RPM 官方架构名是 loongarch64；Debian/AOSC 的 deb 才分别使用 loong64/loongarch64。
Name:           quaver-music
Version:        %{_quaver_version}
Release:        1%{?dist}
Summary:        第三方 QQ 音乐客户端 (loong)
License:        AGPL-3.0-only
URL:            https://github.com/team-quaver/quaver-music
ExclusiveArch:  loongarch64
Source0:        electron-loong64.zip
Source1:        quaver-app.tar.zst
Source2:        quaver.sh
Source3:        quaver.desktop
Source4:        red.0w0.quaver.png
Requires:       mpv
AutoReqProv:    no

%description
Quaver 是一款第三方 QQ 音乐客户端。音频引擎不随包，安装后由发行版 mpv 提供；
Electron 使用 LoongArch64 ABI 2.0 社区构建。

%prep
rm -rf "%{_builddir}/quaver-%{version}"
mkdir -p "%{_builddir}/quaver-%{version}"
cd "%{_builddir}/quaver-%{version}"
unzip -q "%{SOURCE0}" -d electron
mkdir -p electron/resources
tar --zstd -xf "%{SOURCE1}" -C electron/resources

%install
BUILT="%{_builddir}/quaver-%{version}/electron"
mkdir -p \
  "%{buildroot}/opt/quaver/resources" \
  "%{buildroot}/usr/bin" \
  "%{buildroot}/usr/share/applications" \
  "%{buildroot}/usr/share/icons/hicolor/512x512/apps"
cp -a "${BUILT}/." "%{buildroot}/opt/quaver/"
mv "%{buildroot}/opt/quaver/electron" "%{buildroot}/opt/quaver/quaver"
if [ -f "%{buildroot}/opt/quaver/chrome-sandbox" ]; then
  chmod 4755 "%{buildroot}/opt/quaver/chrome-sandbox"
fi
install -m 755 "%{SOURCE2}" "%{buildroot}/opt/quaver/quaver.sh"
ln -s /opt/quaver/quaver.sh "%{buildroot}/usr/bin/quaver"
install -m 644 "%{SOURCE3}" "%{buildroot}/usr/share/applications/red.0w0.quaver.desktop"
install -m 644 "%{SOURCE4}" "%{buildroot}/usr/share/icons/hicolor/512x512/apps/red.0w0.quaver.png"

%files
/opt/quaver
/usr/bin/quaver
/usr/share/applications/red.0w0.quaver.desktop
/usr/share/icons/hicolor/512x512/apps/red.0w0.quaver.png

%changelog
* Sat Oct 17 2026 Ne0W0r1d <ne0w0r1d@ne0w0r1d.top> - %{version}-1
- Add LoongArch64 RPM packaging.
