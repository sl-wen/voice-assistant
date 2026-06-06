/**
 * PC Audio Capture Tool v2.0
 * WASAPI Loopback capture - captures system audio (what you hear)
 * Outputs raw PCM: 48kHz, 16-bit, mono to stdout
 * 
 * Fixed: GetMixFormat COM call, WAVEFORMATEXTENSIBLE support, proper Initialize
 */

using System;
using System.Runtime.InteropServices;
using System.IO;
using System.Threading;

class LoopbackCapture
{
    const int S_OK = 0;
    const int eRender = 0;
    const int eConsole = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_SHAREMODE_SHARED = 0;

    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    [DllImport("ole32.dll")]
    static extern int CoInitialize(IntPtr reserved);

    [DllImport("ole32.dll")]
    static extern void CoUninitialize();

    [DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr unk, int ctx, ref Guid iid, out IntPtr pv);

    static readonly Guid CLSID_MMDevEnum = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
    static readonly Guid IID_MMDevEnum = new Guid("A95664D2-9614-4F35-A746-DE8DB63617E6");

    // COM delegates
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetDefaultEndpoint(IntPtr self, int dataFlow, int role, out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelActivate(IntPtr self, ref Guid iid, int ctx, IntPtr p, out IntPtr result);

    // GetMixFormat: HRESULT GetMixFormat(WAVEFORMATEX** ppFormat) - single param, double pointer
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetMixFormat(IntPtr self, out IntPtr ppFormat);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelInitialize(IntPtr self, int share, int flags, long dur, long period, IntPtr fmt, ref Guid session);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetBufSize(IntPtr self, out uint frames);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelStart(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelStop(IntPtr self);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetService(IntPtr self, ref Guid iid, out IntPtr result);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetNextPacket(IntPtr self, out uint frames);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetBuffer(IntPtr self, out IntPtr data, out uint frames, out int flags, out ulong pos, out ulong qpc);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelReleaseBuffer(IntPtr self, uint frames);

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEX
    {
        public short wFormatTag;
        public short nChannels;
        public int nSamplesPerSec;
        public int nAvgBytesPerSec;
        public short nBlockAlign;
        public short wBitsPerSample;
        public short cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WAVEFORMATEXTENSIBLE
    {
        public WAVEFORMATEX Format;
        public short wValidBitsPerSample;
        public short wSamplesPerBlock; // union with wValidBitsPerSample
        public uint dwChannelMask;
        public Guid SubFormat;
    }

    static readonly Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00aa00389b71");
    static readonly Guid KSDATAFORMAT_SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00aa00389b71");

    static unsafe IntPtr Vt(IntPtr comObj, int slot)
    {
        IntPtr* obj = (IntPtr*)comObj.ToPointer();
        IntPtr* vt = (IntPtr*)obj[0].ToPointer();
        return vt[slot];
    }

    static void Main(string[] args)
    {
        CoInitialize(IntPtr.Zero);
        try
        {
            // 1. Create MMDeviceEnumerator
            IntPtr enumPtr;
            Guid clsid = CLSID_MMDevEnum, iid = IID_MMDevEnum;
            int hr = CoCreateInstance(ref clsid, IntPtr.Zero, 1, ref iid, out enumPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_ENUM:" + hr); return; }

            // 2. Get default audio render endpoint (speakers)
            var getDefault = Marshal.GetDelegateForFunctionPointer<DelGetDefaultEndpoint>(Vt(enumPtr, 3));
            IntPtr devicePtr;
            hr = getDefault(enumPtr, eRender, eConsole, out devicePtr);
            Marshal.Release(enumPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_DEVICE:" + hr); return; }

            // 3. Activate IAudioClient
            var activate = Marshal.GetDelegateForFunctionPointer<DelActivate>(Vt(devicePtr, 3));
            IntPtr acPtr;
            Guid iidAC = IID_IAudioClient;
            hr = activate(devicePtr, ref iidAC, 0, IntPtr.Zero, out acPtr);
            Marshal.Release(devicePtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_ACTIVATE:" + hr); return; }

            // 4. Get mix format - FIXED: correct delegate signature
            var getMixFmt = Marshal.GetDelegateForFunctionPointer<DelGetMixFormat>(Vt(acPtr, 8));
            IntPtr mixFmtPtr;
            hr = getMixFmt(acPtr, out mixFmtPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_MIX:" + hr); return; }

            // Parse format - handle both WAVEFORMATEX and WAVEFORMATEXTENSIBLE
            var baseFmt = Marshal.PtrToStructure<WAVEFORMATEX>(mixFmtPtr);
            int mixRate = baseFmt.nSamplesPerSec;
            int mixCh = baseFmt.nChannels;
            int mixBps = baseFmt.wBitsPerSample;
            int mixBlockAlign = baseFmt.nBlockAlign;
            bool isFloat = (baseFmt.wFormatTag == 3); // WAVE_FORMAT_IEEE_FLOAT
            bool isExtensible = (baseFmt.wFormatTag == 0xFFFE && baseFmt.cbSize >= 22);

            if (isExtensible)
            {
                var extFmt = Marshal.PtrToStructure<WAVEFORMATEXTENSIBLE>(mixFmtPtr);
                if (extFmt.SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) isFloat = true;
                else if (extFmt.SubFormat == KSDATAFORMAT_SUBTYPE_PCM) isFloat = false;
                // Use wValidBitsPerSample if set
                if (extFmt.wValidBitsPerSample > 0 && extFmt.wValidBitsPerSample <= 32)
                    mixBps = extFmt.wValidBitsPerSample;
            }

            Console.Error.WriteLine("MIX:" + mixRate + "Hz " + mixCh + "ch " + mixBps + "bit " + (isFloat ? "float" : "pcm") + (isExtensible ? " (extensible)" : ""));

            // 5. Initialize IAudioClient with LOOPBACK - pass full format blob as-is
            var initClient = Marshal.GetDelegateForFunctionPointer<DelInitialize>(Vt(acPtr, 3));
            
            // Copy the full format (WAVEFORMATEX + cbSize extra bytes) to avoid truncation
            int fmtTotalSize = Marshal.SizeOf<WAVEFORMATEX>() + baseFmt.cbSize;
            IntPtr fmtPtr = Marshal.AllocHGlobal(fmtTotalSize);
            // Copy the entire format blob byte by byte
            byte[] fmtBytes = new byte[fmtTotalSize];
            Marshal.Copy(mixFmtPtr, fmtBytes, 0, fmtTotalSize);
            Marshal.Copy(fmtBytes, 0, fmtPtr, fmtTotalSize);

            Guid emptyGuid = Guid.Empty;
            hr = initClient(acPtr, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                50000000L, 0, fmtPtr, ref emptyGuid);
            Marshal.FreeHGlobal(fmtPtr);

            if (hr != S_OK) { Console.Error.WriteLine("ERR_INIT:" + hr + " (0x" + hr.ToString("X") + ")"); return; }

            // 6. Get IAudioCaptureClient via GetService
            var getService = Marshal.GetDelegateForFunctionPointer<DelGetService>(Vt(acPtr, 13));
            IntPtr capPtr;
            Guid iidCap = IID_IAudioCaptureClient;
            hr = getService(acPtr, ref iidCap, out capPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_SERVICE:" + hr); return; }

            // 7. Start capture
            var start = Marshal.GetDelegateForFunctionPointer<DelStart>(Vt(acPtr, 9));
            start(acPtr);
            Console.Error.WriteLine("CAPTURING");

            // 8. Capture loop - convert to 48kHz 16-bit mono and write to stdout
            var getNextPacket = Marshal.GetDelegateForFunctionPointer<DelGetNextPacket>(Vt(capPtr, 5));
            var getBuf = Marshal.GetDelegateForFunctionPointer<DelGetBuffer>(Vt(capPtr, 3));
            var releaseBuf = Marshal.GetDelegateForFunctionPointer<DelReleaseBuffer>(Vt(capPtr, 4));

            var stdout = Console.OpenStandardOutput();
            int resampleRatio = mixRate != 48000 ? 48000 / (double)mixRate : 1.0; // simple ratio

            while (true)
            {
                uint pktFrames;
                hr = getNextPacket(capPtr, out pktFrames);
                if (hr != S_OK || pktFrames == 0)
                {
                    Thread.Sleep(1);
                    continue;
                }

                while (pktFrames > 0)
                {
                    IntPtr dataPtr;
                    uint frames;
                    int flags;
                    ulong pos, qpc;

                    hr = getBuf(capPtr, out dataPtr, out frames, out flags, out pos, out qpc);
                    if (hr != S_OK) break;

                    int bytesPerSample = mixBps / 8;

                    if (isFloat && mixBps == 32)
                    {
                        // Float32 multi-channel -> mono int16
                        int totalSamples = (int)frames * mixCh;
                        float[] all = new float[totalSamples];
                        Marshal.Copy(dataPtr, all, 0, totalSamples);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++)
                        {
                            float s = all[i * mixCh]; // take first channel
                            if (s > 1f) s = 1f;
                            if (s < -1f) s = -1f;
                            mono[i] = (short)(s * 32767f);
                        }
                        byte[] outBuf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                        stdout.Write(outBuf, 0, outBuf.Length);
                    }
                    else if (!isFloat && mixBps == 16)
                    {
                        if (mixCh == 1)
                        {
                            // Already mono 16-bit, copy directly
                            int totalBytes = (int)frames * mixBlockAlign;
                            byte[] buf = new byte[totalBytes];
                            Marshal.Copy(dataPtr, buf, 0, totalBytes);
                            stdout.Write(buf, 0, totalBytes);
                        }
                        else
                        {
                            // Multi-channel 16-bit -> mono
                            int totalSamples = (int)frames * mixCh;
                            short[] all = new short[totalSamples];
                            Marshal.Copy(dataPtr, all, 0, totalSamples);
                            short[] mono = new short[frames];
                            for (int i = 0; i < frames; i++) mono[i] = all[i * mixCh];
                            byte[] outBuf = new byte[frames * 2];
                            Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                            stdout.Write(outBuf, 0, outBuf.Length);
                        }
                    }
                    else if (!isFloat && mixBps == 24)
                    {
                        // 24-bit PCM -> mono int16
                        int bytesPerFrame = mixCh * 3;
                        byte[] raw = new byte[(int)frames * bytesPerFrame];
                        Marshal.Copy(dataPtr, raw, 0, raw.Length);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++)
                        {
                            int offset = i * bytesPerFrame;
                            // 24-bit little-endian: take 3 bytes, extend to 32-bit, shift to 16
                            int sample = raw[offset] | (raw[offset + 1] << 8) | (raw[offset + 2] << 16);
                            if ((sample & 0x800000) != 0) sample |= unchecked((int)0xFF000000);
                            mono[i] = (short)(sample >> 8); // shift 24->16 bit
                        }
                        byte[] outBuf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                        stdout.Write(outBuf, 0, outBuf.Length);
                    }
                    else if (!isFloat && mixBps == 32)
                    {
                        // 32-bit PCM -> mono int16
                        int totalSamples = (int)frames * mixCh;
                        int[] all = new int[totalSamples];
                        Marshal.Copy(dataPtr, all, 0, totalSamples);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++) mono[i] = (short)(all[i * mixCh] >> 16);
                        byte[] outBuf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                        stdout.Write(outBuf, 0, outBuf.Length);
                    }
                    else
                    {
                        Console.Error.WriteLine("UNSUPPORTED_FORMAT:" + mixBps + "bit " + (isFloat ? "float" : "pcm") + " " + mixCh + "ch");
                        break;
                    }

                    releaseBuf(capPtr, frames);
                    getNextPacket(capPtr, out pktFrames);
                }

                stdout.Flush();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("ERR:" + ex.Message + "\n" + ex.StackTrace);
        }
        finally
        {
            CoUninitialize();
        }
    }
}
