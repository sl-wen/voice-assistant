/* 
 * QR Code generator library (C#)
 * 
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 * 
 * Simplified version - byte mode only, ECC level M
 */

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Text;

static class QrCode
{
    // Error correction level M parameters per version (1-40)
    static readonly int[] EC_CODEWORDS_PER_BLOCK = {
        10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28
    };
    static readonly int[] NUM_EC_BLOCKS = {
        1,1,1,2,2,4,4,4,5,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47
    };
    static readonly int[] NUM_DATA_CODEWORDS = {
        16,28,44,64,86,108,124,154,182,216,254,290,334,365,415,453,507,563,627,669,
        714,782,860,914,1000,1062,1128,1193,1267,1373,1455,1541,1631,1725,1817,1911,1993,2109,2213,2331
    };

    public static Bitmap Generate(string text, int size)
    {
        bool[][] modules = EncodeText(text);
        return Render(modules, size);
    }

    static bool[][] EncodeText(string text)
    {
        byte[] data = Encoding.UTF8.GetBytes(text);
        int version = 1;
        for (; version <= 40; version++)
        {
            int dataCap = NUM_DATA_CODEWORDS[version - 1];
            // Byte mode: 4 bits mode indicator + 8/16 bits count + data + terminator
            int ccBits = version <= 9 ? 8 : 16;
            int overhead = (4 + ccBits + 7) / 8;
            if (data.Length <= dataCap - overhead) break;
        }
        if (version > 40) throw new ArgumentException("Data too long");

        int size = version * 4 + 17;
        int totalCodewords = GetTotalCodewords(version);
        int dataCodewords = NUM_DATA_CODEWORDS[version - 1];
        int ecCodewordsPerBlock = EC_CODEWORDS_PER_BLOCK[version - 1];
        int numBlocks = NUM_EC_BLOCKS[version - 1];
        int ecTotal = ecCodewordsPerBlock * numBlocks;

        // --- Bit stream ---
        var bits = new List<bool>();
        AddBits(bits, 0b0100, 4); // byte mode
        AddBits(bits, data.Length, version <= 9 ? 8 : 16);
        foreach (byte b in data)
            AddBits(bits, b, 8);
        // Terminator
        int maxBits = dataCodewords * 8;
        for (int i = 0; i < 4 && bits.Count < maxBits; i++) bits.Add(false);
        while (bits.Count % 8 != 0) bits.Add(false);
        // Pad codewords
        bool padToggle = false;
        while (bits.Count < maxBits)
        {
            AddBits(bits, padToggle ? 0x11 : 0xEC, 8);
            padToggle = !padToggle;
        }

        // Convert to byte array
        byte[] dataBytes = new byte[dataCodewords];
        for (int i = 0; i < dataCodewords; i++)
        {
            byte val = 0;
            for (int j = 0; j < 8; j++)
                if (i * 8 + j < bits.Count && bits[i * 8 + j])
                    val |= (byte)(1 << (7 - j));
            dataBytes[i] = val;
        }

        // --- Split into blocks, compute EC ---
        int shortBlockLen = dataCodewords / numBlocks;
        int numLongBlocks = dataCodewords % numBlocks;
        var dataBlocks = new List<byte[]>();
        var ecBlocks = new List<byte[]>();
        int off = 0;
        for (int i = 0; i < numBlocks; i++)
        {
            int bLen = shortBlockLen + (i >= numBlocks - numLongBlocks ? 1 : 0);
            byte[] block = new byte[bLen];
            Array.Copy(dataBytes, off, block, 0, bLen);
            off += bLen;
            dataBlocks.Add(block);
            ecBlocks.Add(ReedSolomon(block, ecCodewordsPerBlock));
        }

        // --- Interleave ---
        var result = new List<byte>();
        // Data
        for (int i = 0; i < shortBlockLen + 1; i++)
            for (int b = 0; b < numBlocks; b++)
                if (i < dataBlocks[b].Length) result.Add(dataBlocks[b][i]);
        // EC
        for (int i = 0; i < ecCodewordsPerBlock; i++)
            for (int b = 0; b < numBlocks; b++)
                result.Add(ecBlocks[b][i]);

        byte[] codewords = result.ToArray();

        // --- Create matrix ---
        var modules2 = new bool[size][]; // true = dark
        var isFunc = new bool[size][];
        for (int i = 0; i < size; i++)
        {
            modules2[i] = new bool[size];
            isFunc[i] = new bool[size];
        }

        // Function patterns
        DrawFinderPattern(modules2, isFunc, 0, 0);
        DrawFinderPattern(modules2, isFunc, size - 7, 0);
        DrawFinderPattern(modules2, isFunc, 0, size - 7);
        DrawAlignmentPatterns(modules2, isFunc, version);
        DrawTimingPatterns(modules2, isFunc, size);
        // Dark module
        modules2[size - 8][8] = true; isFunc[size - 8][8] = true;

        // Format info placeholder (mark as function)
        for (int i = 0; i < 9; i++)
        {
            isFunc[8][i] = true; isFunc[i][8] = true;
            isFunc[8][size - 1 - i] = true; isFunc[size - 1 - i][8] = true;
        }

        // Version info (v7+)
        if (version >= 7)
        {
            int vBits = version;
            for (int i = 0; i < 12; i++) vBits = (vBits << 1) ^ (((vBits >> 11) & 1) * 0x1F25);
            int vInfo = (version << 12) | (vBits & 0xFFF);
            for (int i = 0; i < 18; i++)
            {
                bool bit = ((vInfo >> i) & 1) == 1;
                int r = size - 11 + i % 3, c = i / 3;
                modules2[r][c] = bit; isFunc[r][c] = true;
                modules2[c][r] = bit; isFunc[c][r] = true;
            }
        }

        // Place data with mask evaluation (try all 8 masks, pick best)
        int bestMask = 0;
        int bestPenalty = int.MaxValue;
        for (int mask = 0; mask < 8; mask++)
        {
            var tempModules = CopyMatrix(modules2);
            PlaceData(tempModules, isFunc, codewords, size, mask);
            DrawFormatInfo(tempModules, isFunc, size, mask);
            int penalty = ComputePenalty(tempModules, size);
            if (penalty < bestPenalty)
            {
                bestPenalty = penalty;
                bestMask = mask;
            }
        }

        // Apply best mask
        PlaceData(modules2, isFunc, codewords, size, bestMask);
        DrawFormatInfo(modules2, isFunc, size, bestMask);

        return modules2;
    }

    static void AddBits(List<bool> bits, int val, int count)
    {
        for (int i = count - 1; i >= 0; i--)
            bits.Add(((val >> i) & 1) == 1);
    }

    static int GetTotalCodewords(int version)
    {
        int ecPerBlock = EC_CODEWORDS_PER_BLOCK[version - 1];
        int numBlocks = NUM_EC_BLOCKS[version - 1];
        return NUM_DATA_CODEWORDS[version - 1] + ecPerBlock * numBlocks;
    }

    static void DrawFinderPattern(bool[][] m, bool[][] f, int ox, int oy)
    {
        for (int dy = -1; dy <= 7; dy++)
            for (int dx = -1; dx <= 7; dx++)
            {
                int x = ox + dx, y = oy + dy;
                if (x < 0 || y < 0 || x >= m[0].Length || y >= m.Length) continue;
                bool black = (dx >= 0 && dx <= 6 && (dy == 0 || dy == 6)) ||
                             (dy >= 0 && dy <= 6 && (dx == 0 || dx == 6)) ||
                             (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
                m[y][x] = black;
                f[y][x] = true;
            }
    }

    static void DrawAlignmentPatterns(bool[][] m, bool[][] f, int version)
    {
        int[] positions = GetAlignmentPositions(version);
        foreach (int cy in positions)
            foreach (int cx in positions)
            {
                if (f[cy][cx]) continue;
                for (int dy = -2; dy <= 2; dy++)
                    for (int dx = -2; dx <= 2; dx++)
                    {
                        bool black = Math.Abs(dx) == 2 || Math.Abs(dy) == 2 || (dx == 0 && dy == 0);
                        m[cy + dy][cx + dx] = black;
                        f[cy + dy][cx + dx] = true;
                    }
            }
    }

    static int[] GetAlignmentPositions(int version)
    {
        if (version == 1) return new int[0];
        int[] align = new int[2 + (version / 7)];
        align[0] = 6;
        int last = version * 4 + 10;
        align[align.Length - 1] = last;
        if (align.Length == 3) align[1] = 6 + (last - 6) / 2 + ((last - 6) % 2 != 0 ? 1 : 0);
        else if (align.Length > 3)
        {
            int step = (last - 6) / (align.Length - 1);
            if (step % 2 != 0) step++;
            for (int i = 1; i < align.Length; i++)
                align[i] = 6 + step * i;
            align[align.Length - 1] = last;
        }
        return align;
    }

    static void DrawTimingPatterns(bool[][] m, bool[][] f, int size)
    {
        for (int i = 8; i < size - 8; i++)
        {
            m[6][i] = i % 2 == 0; f[6][i] = true;
            m[i][6] = i % 2 == 0; f[i][6] = true;
        }
    }

    static void PlaceData(bool[][] m, bool[][] f, byte[] codewords, int size, int mask)
    {
        int bitIdx = 0;
        for (int right = size - 1; right >= 1; right -= 2)
        {
            if (right == 6) right = 5;
            for (int vert = 0; vert < size; vert++)
            {
                for (int j = 0; j < 2; j++)
                {
                    int x = right - j;
                    bool upward = ((right + 1) & 2) == 0;
                    int y = upward ? size - 1 - vert : vert;
                    if (!f[y][x] && bitIdx < codewords.Length * 8)
                    {
                        bool bit = ((codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1) == 1;
                        bitIdx++;
                        if (ApplyMask(mask, x, y)) bit = !bit;
                        m[y][x] = bit;
                    }
                }
            }
        }
    }

    static bool ApplyMask(int mask, int x, int y)
    {
        switch (mask)
        {
            case 0: return (y + x) % 2 == 0;
            case 1: return y % 2 == 0;
            case 2: return x % 3 == 0;
            case 3: return (y + x) % 3 == 0;
            case 4: return (y / 2 + x / 3) % 2 == 0;
            case 5: return (y * x) % 2 + (y * x) % 3 == 0;
            case 6: return ((y * x) % 2 + (y * x) % 3) % 2 == 0;
            case 7: return ((y + x) % 2 + (y * x) % 3) % 2 == 0;
        }
        return false;
    }

    static void DrawFormatInfo(bool[][] m, bool[][] f, int size, int mask)
    {
        // EC level M = 0b10, mask = mask
        int data = (2 << 3) | mask;
        int remainder = data;
        for (int i = 0; i < 10; i++)
            remainder = (remainder << 1) ^ (((remainder >> 9) & 1) * 0x537);
        int formatBits = ((data << 10) | (remainder & 0x3FF)) ^ 0x5412;

        // Copy 1: around top-left
        for (int i = 0; i <= 5; i++) { m[8][i] = ((formatBits >> i) & 1) == 1; f[8][i] = true; }
        m[8][7] = ((formatBits >> 6) & 1) == 1; f[8][7] = true;
        m[8][8] = ((formatBits >> 7) & 1) == 1; f[8][8] = true;
        m[7][8] = ((formatBits >> 8) & 1) == 1; f[7][8] = true;
        for (int i = 9; i < 15; i++) { m[14 - i][8] = ((formatBits >> i) & 1) == 1; f[14 - i][8] = true; }

        // Copy 2
        for (int i = 0; i < 7; i++) { m[size - 1 - i][8] = ((formatBits >> i) & 1) == 1; f[size - 1 - i][8] = true; }
        for (int i = 7; i < 15; i++) { m[8][size - 15 + i] = ((formatBits >> i) & 1) == 1; f[8][size - 15 + i] = true; }
    }

    static int ComputePenalty(bool[][] m, int size)
    {
        int penalty = 0;
        // Rule 1: 5+ same-color in row/col
        for (int y = 0; y < size; y++)
        {
            int run = 1;
            for (int x = 1; x < size; x++)
            {
                if (m[y][x] == m[y][x - 1]) { run++; if (run == 5) penalty += 3; else if (run > 5) penalty++; }
                else run = 1;
            }
        }
        for (int x = 0; x < size; x++)
        {
            int run = 1;
            for (int y = 1; y < size; y++)
            {
                if (m[y][x] == m[y - 1][x]) { run++; if (run == 5) penalty += 3; else if (run > 5) penalty++; }
                else run = 1;
            }
        }
        // Rule 2: 2x2 blocks
        for (int y = 0; y < size - 1; y++)
            for (int x = 0; x < size - 1; x++)
            {
                bool c = m[y][x];
                if (c == m[y][x + 1] && c == m[y + 1][x] && c == m[y + 1][x + 1]) penalty += 3;
            }
        return penalty;
    }

    static bool[][] CopyMatrix(bool[][] src)
    {
        var copy = new bool[src.Length][];
        for (int i = 0; i < src.Length; i++)
        {
            copy[i] = new bool[src[i].Length];
            Array.Copy(src[i], copy[i], src[i].Length);
        }
        return copy;
    }

    // GF(256) arithmetic
    static readonly byte[] GF_EXP = new byte[512];
    static readonly byte[] GF_LOG = new byte[256];
    static QrCode()
    {
        int x = 1;
        for (int i = 0; i < 255; i++)
        {
            GF_EXP[i] = (byte)x; GF_EXP[i + 255] = (byte)x;
            GF_LOG[x] = (byte)i;
            x = (x << 1) ^ (x >= 128 ? 0x11D : 0);
        }
    }

    static byte GfMul(int a, int b)
    {
        return (a == 0 || b == 0) ? (byte)0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
    }

    static byte[] ReedSolomon(byte[] data, int degree)
    {
        byte[] gen = RsGenPoly(degree);
        byte[] result = new byte[degree];
        foreach (byte b in data)
        {
            byte factor = (byte)(b ^ result[0]);
            Array.Copy(result, 1, result, 0, result.Length - 1);
            result[result.Length - 1] = 0;
            for (int i = 0; i < degree; i++)
                result[i] ^= GfMul(gen[i], factor);
        }
        return result;
    }

    static byte[] RsGenPoly(int degree)
    {
        byte[] coeffs = new byte[degree];
        coeffs[degree - 1] = 1;
        int root = 1;
        for (int i = 0; i < degree; i++)
        {
            for (int j = 0; j < degree; j++)
            {
                coeffs[j] = GfMul(coeffs[j], (byte)root);
                if (j + 1 < degree) coeffs[j] ^= coeffs[j + 1];
            }
            root = (root << 1) ^ (root >= 128 ? 0x11D : 0);
        }
        return coeffs;
    }

    static Bitmap Render(bool[][] modules, int imgSize)
    {
        int qrSize = modules.Length;
        int border = 2;
        int total = qrSize + border * 2;
        int pxPerModule = Math.Max(1, imgSize / total);
        int actualSize = total * pxPerModule;

        var bmp = new Bitmap(actualSize, actualSize, PixelFormat.Format24bppRgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.White);
            var brush = new SolidBrush(Color.FromArgb(30, 30, 50));
            for (int y = 0; y < qrSize; y++)
                for (int x = 0; x < qrSize; x++)
                    if (modules[y][x])
                        g.FillRectangle(brush,
                            (x + border) * pxPerModule,
                            (y + border) * pxPerModule,
                            pxPerModule, pxPerModule);
        }
        return bmp;
    }
}
