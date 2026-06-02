/**
 * PC Audio Capture Tool
 * WASAPI Loopback capture - captures system audio (what you hear)
 * Outputs raw PCM: 48kHz, 16-bit, mono to stdout
 * 
 * Compiled on first run via csc.exe (Windows built-in C# compiler)
 * 
 * Usage: audio-capture.exe [sample_rate]
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

    // COM vtable delegates
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelGetDefaultEndpoint(IntPtr self, int dataFlow, int role, out IntPtr device);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate int DelActivate(IntPtr self, ref Guid iid, int ctx, IntPtr p, out IntPtr result);

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

            // 4. Get mix format (device native format)
            // IAudioClient vtable: 3=Initialize,4=GetBufSize,5=GetLatency,6=GetPadding,
            // 7=IsFormatSupported,8=GetMixFormat,9=GetDevPeriod,10=Start,11=Stop,12=Reset,13=GetService
            var getMixFmt = Marshal.GetDelegateForFunctionPointer<DelActivate>(Vt(acPtr, 8));
            IntPtr mixFmtPtr;
            // GetMixFormat has different signature - use raw delegate
            var getMixFmtRaw = Marshal.GetDelegateForFunctionPointer<DelGetDefaultEndpoint>(Vt(acPtr, 8));
            hr = getMixFmtRaw(acPtr, 0, 0, out mixFmtPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_MIX:" + hr); return; }

            var mixFmt = Marshal.PtrToStructure<WAVEFORMATEX>(mixFmtPtr);
            int mixRate = mixFmt.nSamplesPerSec;
            int mixCh = mixFmt.nChannels;
            int mixBps = mixFmt.wBitsPerSample;
            int mixBlockAlign = mixFmt.nBlockAlign;
            Console.Error.WriteLine("MIX:" + mixRate + "Hz " + mixCh + "ch " + mixBps + "bit");

            // 5. Initialize IAudioClient with LOOPBACK
            var initClient = Marshal.GetDelegateForFunctionPointer<DelInitialize>(Vt(acPtr, 3));
            IntPtr fmtPtr = Marshal.AllocHGlobal(Marshal.SizeOf<WAVEFORMATEX>());
            Marshal.StructureToPtr(mixFmt, fmtPtr, false);
            Guid emptyGuid = Guid.Empty;

            hr = initClient(acPtr, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                500000, 0, fmtPtr, ref emptyGuid);
            Marshal.FreeHGlobal(fmtPtr);
            if (hr != S_OK) { Console.Error.WriteLine("ERR_INIT:" + hr); return; }

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

            // 8. Capture loop - write PCM to stdout
            var getNextPacket = Marshal.GetDelegateForFunctionPointer<DelGetNextPacket>(Vt(capPtr, 5));
            var getBuf = Marshal.GetDelegateForFunctionPointer<DelGetBuffer>(Vt(capPtr, 3));
            var releaseBuf = Marshal.GetDelegateForFunctionPointer<DelReleaseBuffer>(Vt(capPtr, 4));

            var stdout = Console.OpenStandardOutput();

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

                    int totalBytes = (int)frames * mixBlockAlign;

                    if (mixCh == 1 && mixBps == 16)
                    {
                        // Already mono 16-bit, copy directly
                        byte[] buf = new byte[totalBytes];
                        Marshal.Copy(dataPtr, buf, 0, totalBytes);
                        stdout.Write(buf, 0, totalBytes);
                    }
                    else if (mixBps == 16)
                    {
                        // Multi-channel 16-bit -> take first channel (mono)
                        int samples = (int)frames * mixCh;
                        short[] all = new short[samples];
                        Marshal.Copy(dataPtr, all, 0, samples);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++) mono[i] = all[i * mixCh];
                        byte[] outBuf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                        stdout.Write(outBuf, 0, outBuf.Length);
                    }
                    else if (mixBps == 32)
                    {
                        // Float32 -> mono int16
                        int samples = (int)frames * mixCh;
                        float[] all = new float[samples];
                        Marshal.Copy(dataPtr, all, 0, samples);
                        short[] mono = new short[frames];
                        for (int i = 0; i < frames; i++)
                        {
                            float s = all[i * mixCh];
                            if (s > 1f) s = 1f;
                            if (s < -1f) s = -1f;
                            mono[i] = (short)(s * 32767f);
                        }
                        byte[] outBuf = new byte[frames * 2];
                        Buffer.BlockCopy(mono, 0, outBuf, 0, outBuf.Length);
                        stdout.Write(outBuf, 0, outBuf.Length);
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
