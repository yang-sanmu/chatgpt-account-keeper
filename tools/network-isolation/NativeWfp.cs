using System.Runtime.InteropServices;

namespace GptAccountKeeper.NetworkIsolation;

// SDK 10.0.26100.0, fwptypes.h/fwpmtypes.h/fwpmu.h. All layouts target x64.
internal static unsafe partial class NativeWfp
{
    internal static readonly Guid Connect4 = new("c38d57d1-05a7-4c33-904f-7fbceee60e82");
    internal static readonly Guid Connect6 = new("4a72393b-319f-44bc-84c3-ba54dcb3b6b4");
    internal static readonly Guid Bind4 = new("1247d66d-0b60-4a15-8d44-7155d0f53a0c");
    internal static readonly Guid Bind6 = new("55a650e1-5f0a-4eca-a653-88f53b26aa8c");
    internal static readonly Guid Listen4 = new("88bb5dad-76d7-4227-9c71-df0a3ed7be7e");
    internal static readonly Guid Listen6 = new("7ac9de24-17dd-4814-b4bd-a9fbc95a321b");
    internal static readonly Guid Receive4 = new("e1cd9fe7-f4b5-4273-96c0-592e487b8650");
    internal static readonly Guid Receive6 = new("a3b42c97-9f04-4672-b87e-cee9c483257f");
    internal static readonly Guid AppId = new("d78e1e87-8644-4ea5-9437-d809ecefc971");
    internal static readonly Guid UserId = new("af043a0a-b34d-4f86-979c-c90371af6e66");
    internal static readonly Guid LocalAddress = new("d9ee00de-c1ef-4617-bfe3-ffd8f5a08957");
    internal static readonly Guid RemoteAddress = new("b235ae9a-1d64-49b8-a44c-5ff3d9095045");
    internal static readonly Guid RemotePort = new("c35a604d-d22b-4e1a-91b4-68f674ee674b");
    internal static readonly Guid LocalPort = new("0c1ba1af-5765-453f-af22-a8f791ac775b");
    internal static readonly Guid Protocol = new("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
    internal const uint AlreadyExists = 0x80320009;
    internal const uint FilterNotFound = 0x80320003;
    internal const uint ProviderNotFound = 0x80320005;
    internal const uint SublayerNotFound = 0x80320007;
    internal const uint Block = 0x1001;
    internal const uint Permit = 0x1002;

    [StructLayout(LayoutKind.Sequential)]
    internal struct Display { internal nint Name; internal nint Description; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Blob { internal uint Size; internal nint Data; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct V4Mask { internal uint Address; internal uint Mask; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct V6Mask { internal fixed byte Address[16]; internal byte PrefixLength; }
    [StructLayout(LayoutKind.Explicit, Size = 16)]
    internal struct Value
    {
        [FieldOffset(0)] internal uint Type;
        [FieldOffset(8)] internal byte U8;
        [FieldOffset(8)] internal ushort U16;
        [FieldOffset(8)] internal uint U32;
        [FieldOffset(8)] internal nint Pointer;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Condition { internal Guid Key; internal uint Match; internal Value Value; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Session
    {
        internal Guid Key; internal Display Display; internal uint Flags; internal uint Timeout;
        internal uint ProcessId; internal nint Sid; internal nint Username; internal int KernelMode;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Provider
    {
        internal Guid Key; internal Display Display; internal uint Flags;
        internal Blob Data; internal nint ServiceName;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Sublayer
    {
        internal Guid Key; internal Display Display; internal uint Flags;
        internal nint ProviderKey; internal Blob Data; internal ushort Weight;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Action { internal uint Type; internal Guid Key; }
    [StructLayout(LayoutKind.Explicit, Size = 16)]
    internal struct Context { [FieldOffset(0)] internal ulong Raw; [FieldOffset(0)] internal Guid Key; }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Filter
    {
        internal Guid Key; internal Display Display; internal uint Flags; internal nint ProviderKey;
        internal Blob Data; internal Guid Layer; internal Guid Sublayer; internal Value Weight;
        internal uint Count; internal nint Conditions; internal Action Action; internal Context Context;
        internal nint Reserved; internal ulong Id; internal Value EffectiveWeight;
    }

    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmEngineOpen0")]
    internal static partial uint Open(nint server, uint auth, nint identity, in Session session, out nint engine);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmEngineClose0")]
    internal static partial uint Close(nint engine);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmTransactionBegin0")]
    internal static partial uint Begin(nint engine, uint flags);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmTransactionCommit0")]
    internal static partial uint Commit(nint engine);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmTransactionAbort0")]
    internal static partial uint Abort(nint engine);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmProviderAdd0")]
    internal static partial uint AddProvider(nint engine, in Provider provider, nint sd);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmSubLayerAdd0")]
    internal static partial uint AddSublayer(nint engine, in Sublayer sublayer, nint sd);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmFilterAdd0")]
    internal static partial uint AddFilter(nint engine, in Filter filter, nint sd, out ulong id);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmFilterDeleteByKey0")]
    internal static partial uint DeleteFilter(nint engine, in Guid key);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmFilterGetByKey0")]
    internal static partial uint GetFilter(nint engine, in Guid key, out nint filter);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmProviderGetByKey0")]
    internal static partial uint GetProvider(nint engine, in Guid key, out nint provider);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmSubLayerGetByKey0")]
    internal static partial uint GetSublayer(nint engine, in Guid key, out nint sublayer);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmSubLayerDeleteByKey0")]
    internal static partial uint DeleteSublayer(nint engine, in Guid key);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmProviderDeleteByKey0")]
    internal static partial uint DeleteProvider(nint engine, in Guid key);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmGetAppIdFromFileName0", StringMarshalling = StringMarshalling.Utf16)]
    internal static partial uint GetAppId(string path, out nint blob);
    [LibraryImport("fwpuclnt.dll", EntryPoint = "FwpmFreeMemory0")]
    internal static partial void Free(ref nint pointer);

    internal static void Check(uint result, string operation)
    {
        if (result != 0) throw new InvalidOperationException($"{operation}: WFP error 0x{result:x8}");
    }
    internal static void CheckLayout()
    {
        if (IntPtr.Size != 8 || sizeof(Filter) != 200 || sizeof(Condition) != 40
            || sizeof(Value) != 16 || sizeof(Session) != 72 || sizeof(Provider) != 64
            || sizeof(Sublayer) != 72 || sizeof(Blob) != 16 || sizeof(V4Mask) != 8 || sizeof(V6Mask) != 17
            || Marshal.OffsetOf<V6Mask>(nameof(V6Mask.PrefixLength)) != 16
            || Marshal.OffsetOf<Filter>(nameof(Filter.Conditions)) != 120
            || Marshal.OffsetOf<Filter>(nameof(Filter.Action)) != 128)
            throw new PlatformNotSupportedException("WFP x64 ABI layout mismatch");
    }
}
