# Self-contained package: bundled Node.js + MariaDB binaries must reach the customer byte-for-byte.
%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none
%global _missing_build_ids_terminate_build 0
# Plain "1" release (no .fcNN suffix) so the same file installs on RHEL/Alma/Rocky/Fedora; xz = readable by every rpm >= 4.8.
%define dist %{nil}
%define _binary_payload w6.xzdio
%define _binary_filedigest_algorithm 8

Name:           dcim
Version:        3.2.2
Release:        1%{?dist}
Summary:        DCIM Dashboard - Data Center Infrastructure Management
License:        Proprietary
URL:            https://example.com/dcim
BuildArch:      x86_64
Requires:       systemd
# Only what the bundled MariaDB engine links outside its own bundle (soname-based, resolved by dnf/yum on RHEL 8/9/10, Rocky, Alma, Fedora, openSUSE).
Requires:       libcrypt.so.1()(64bit)
Requires:       libsystemd.so.0()(64bit)
Recommends:     mariadb-server
AutoReqProv:    no

%description
Offline-capable DCIM web application (Node.js/Express + MySQL/MariaDB).
Installs as a systemd service. After installing this package, run
`sudo dcim-setup` to complete first-time configuration (database
connection, port, admin account).

%prep
# no-op: sources are staged directly by build-rpm.sh via the install section below

%build
# no-op: the application ships pre-built (node_modules/libs/ocr already vendored)

%install
rm -rf %{buildroot}
mkdir -p %{buildroot}/usr/share/dcim %{buildroot}/usr/bin
cp -a "%{_sourcedir}/dcim-payload/." %{buildroot}/usr/share/dcim/
ln -s /usr/share/dcim/install.sh %{buildroot}/usr/bin/dcim-setup
install -m 755 "%{_sourcedir}/dcim-service.sh" %{buildroot}/usr/bin/dcim-service
install -m 755 "%{_sourcedir}/dcim-upgrade.sh" %{buildroot}/usr/bin/dcim-upgrade
install -m 755 "%{_sourcedir}/dcim-repair.sh" %{buildroot}/usr/bin/dcim-repair

%files
%attr(755,root,root) /usr/share/dcim/install.sh
%attr(755,root,root) /usr/share/dcim/uninstall.sh
%attr(755,root,root) /usr/share/dcim/rollback.sh
/usr/share/dcim/dcim.service.template
/usr/share/dcim/dcim-mariadb.service.template
/usr/share/dcim/nginx-dcim.conf
/usr/share/dcim/webapp
/usr/share/dcim/runtime
%dir /usr/share/dcim
/usr/bin/dcim-setup
%attr(755,root,root) /usr/bin/dcim-service
%attr(755,root,root) /usr/bin/dcim-upgrade
%attr(755,root,root) /usr/bin/dcim-repair

%post
case "$1" in
  2)
    # upgrade (2 = new version being installed, old still present)
    if [ -f /opt/dcim/webapp/.env ]; then
      /usr/share/dcim/install.sh --mode upgrade --yes || \
        echo "dcim: automatic upgrade failed; run 'sudo dcim-setup --mode upgrade' to retry." >&2
    fi
    ;;
  1)
    cat <<'EOF'

DCIM files have been installed to /usr/share/dcim.
Run the following to finish setup (creates the systemd service, database,
and admin account):

    sudo dcim-setup

EOF
    ;;
esac

%preun
if [ "$1" = "0" ]; then
  # full removal (not an upgrade)
  systemctl stop dcim 2>/dev/null || true
  systemctl disable dcim 2>/dev/null || true
  # embedded database (only present if --embedded-db was used)
  systemctl stop dcim-mariadb 2>/dev/null || true
  systemctl disable dcim-mariadb 2>/dev/null || true
fi

%postun
if [ "$1" = "0" ]; then
  rm -f /etc/systemd/system/dcim.service /etc/systemd/system/dcim-mariadb.service
  systemctl daemon-reload 2>/dev/null || true
  echo "dcim: package removed. Application data in /opt/dcim was left in place;" >&2
  echo "remove it manually with: sudo rm -rf /opt/dcim" >&2
fi

%changelog
* Wed Oct 14 2026 DCIM Packaging <support@example.com> - 3.2.2-1
- Self-contained RPM: bundled Node.js and embedded MariaDB (same as .deb/appliance)
