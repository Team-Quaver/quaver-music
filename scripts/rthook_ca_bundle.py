"""PyInstaller 运行时钩子：修好冻结二进制的 TLS 信任库。

为什么需要
----------
PyInstaller 会把构建机的那份 libssl/libcrypto 一起冻进包里，而 OpenSSL 的默认 CA
路径是编译期写死的（``openssl version -d`` 里的 OPENSSLDIR）—— 也就是**构建机那个
发行版的布局**。本仓库 CI 跑在 ubuntu-24.04 上，那份 OpenSSL 找的是 /usr/lib/ssl。

于是二进制只在 Debian 系上好使：Arch（/etc/ssl）、Fedora（/etc/pki/tls）、
openSUSE（/etc/ssl）上那个目录根本不存在，``ssl.create_default_context()``
一个根证书都加载不到。

症状很隐蔽，因为只有一部分网络栈中招：

* SDK 的 HTTP 栈（niquests / urllib3-future）用 wassima 显式读系统信任库，
  所以歌单、搜索、播放地址全部正常；
* 而 paho-mqtt 的 MQTT-over-WSS 直接调 ``ssl.create_default_context()``
  （paho/mqtt/client.py:tls_set_context），收到服务器证书链后无法验证，
  自己发 fatal alert ``unknown_ca(48)`` 把连接掐掉。

最终表现：手机扫码登录一直不成功，日志里反复刷
``mobile 二维码事件流异常: MQTT TCP connect failed before CONNACK``，
而应用其它功能一切正常 —— 很难往「证书」上想。

做什么
------
进程启动时（任何连接建立之前）看一眼默认信任库：

* 非空 —— 什么都不做，零开销（Debian 系上跑就是这条路径）；
* 为空 —— 按常见发行版位置找一个系统 CA 包，写回 ``SSL_CERT_FILE``。
  这是 OpenSSL 认的标准环境变量，会覆盖编译期的默认 cafile，
  之后所有 ``create_default_context()`` 都跟着用上。

指向运行机自己的 CA 包（而不是随包带一份根证书），是为了跟 HTTP 栈保持同一个
信任源：用户自装的企业 CA 同样对 MQTT 生效。

运行时钩子由 PyInstaller 在主脚本之前执行，所以一定早于任何握手。
"""

from __future__ import annotations

import os
import ssl
import sys

_TAG = "[ca-bundle]"

# 合并式 CA 包（单个 PEM 文件），按主流程度排。用文件而非目录：OpenSSL 的
# SSL_CERT_DIR 要求目录里的证书按 c_rehash 哈希命名，只有 Debian 系满足。
CA_BUNDLES = (
    "/etc/ssl/certs/ca-certificates.crt",  # Debian / Ubuntu / Arch / Alpine
    "/etc/pki/tls/certs/ca-bundle.crt",    # Fedora / RHEL / CentOS
    "/etc/ssl/ca-bundle.pem",              # openSUSE
    "/etc/ssl/cert.pem",                   # Alpine / 各 BSD
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  # RHEL 系另一处
)


def _trusted_ca_count() -> int:
    """当前 OpenSSL 配置下能加载出多少个 CA 证书；出错返回 -1。"""
    try:
        return int(ssl.create_default_context().cert_store_stats().get("x509_ca", 0))
    except Exception:  # noqa: BLE001 —— 钩子不能因为探测失败就把进程带走
        return -1


def _install() -> str | None:
    """把 SSL_CERT_FILE 指到第一个真正可用的系统 CA 包，返回用了哪个。"""
    for path in CA_BUNDLES:
        if not os.path.isfile(path):
            continue
        os.environ["SSL_CERT_FILE"] = path
        if _trusted_ca_count() > 0:  # 文件在但不含证书（空文件/占位）就接着找下一个
            return path
    return None


def main() -> None:
    if _trusted_ca_count() > 0:
        return

    found = _install()
    if found is not None:
        print(f"{_TAG} 默认信任库为空（构建机那套 OpenSSL 默认路径在运行机上不存在），"
              f"已改用 {found}", file=sys.stderr)
    else:
        print(f"{_TAG} 警告：默认信任库为空，且找不到可用的系统 CA 包 —— TLS 校验将失败",
              file=sys.stderr)


main()
