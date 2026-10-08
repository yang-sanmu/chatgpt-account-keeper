param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'

# Ephemeral keys only: no X509Store, Cert: provider, policy or OS trust changes.
$labBase = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../artifacts/network-lab'))
$destination = [IO.Path]::GetFullPath($OutputDirectory)
if (-not $destination.StartsWith($labBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Certificates must stay inside a fresh network-lab fixture'
}
if (-not [IO.Directory]::Exists($destination) -or [IO.Directory]::GetFileSystemEntries($destination).Length -ne 0) {
    throw 'Certificate directory must already exist and be empty'
}
$rootKey = [Security.Cryptography.RSA]::Create(2048)
$serverKey = [Security.Cryptography.RSA]::Create(2048)
$untrustedKey = [Security.Cryptography.RSA]::Create(2048)
$now = [DateTimeOffset]::UtcNow
$hash = [Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [Security.Cryptography.RSASignaturePadding]::Pkcs1
function New-ServerRequest($key) {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Network Lab Only', $key, $hash, $padding)
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature, $true))
    $eku = [Security.Cryptography.OidCollection]::new()
    [void]$eku.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
    $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $false))
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.1'))
    $san.AddIpAddress([Net.IPAddress]::Parse('127.0.0.2'))
    $request.CertificateExtensions.Add($san.Build())
    return $request
}
try {
    $rootRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Ephemeral Network Lab Root', $rootKey, $hash, $padding)
    $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $true, 0, $true))
    $rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
    $rootCert = $rootRequest.CreateSelfSigned($now.AddMinutes(-5), $now.AddDays(1))
    $serverRequest = New-ServerRequest $serverKey
    $serverCert = $serverRequest.Create($rootCert, $now.AddMinutes(-5), $now.AddHours(12), [Security.Cryptography.RandomNumberGenerator]::GetBytes(16))
    $untrustedRequest = New-ServerRequest $untrustedKey
    $untrustedCert = $untrustedRequest.CreateSelfSigned($now.AddMinutes(-5), $now.AddHours(12))
    [IO.File]::WriteAllBytes((Join-Path $destination 'root.der'), $rootCert.RawData)
    [IO.File]::WriteAllText((Join-Path $destination 'server.pem'), $serverCert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $destination 'server.key'), $serverKey.ExportPkcs8PrivateKeyPem())
    [IO.File]::WriteAllText((Join-Path $destination 'untrusted.pem'), $untrustedCert.ExportCertificatePem())
    [IO.File]::WriteAllText((Join-Path $destination 'untrusted.key'), $untrustedKey.ExportPkcs8PrivateKeyPem())
} finally {
    if ($rootCert) { $rootCert.Dispose() }
    if ($serverCert) { $serverCert.Dispose() }
    if ($untrustedCert) { $untrustedCert.Dispose() }
    $rootKey.Dispose(); $serverKey.Dispose(); $untrustedKey.Dispose()
}
