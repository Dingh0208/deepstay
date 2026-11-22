package xyz.infralyx.deepstay;

import static org.junit.Assert.*;

import org.junit.Test;

public class CallAudioPluginTest {
    @Test
    public void pcmFramesUseLittleEndianSignedSamples() {
        byte[] bytes = CallAudioPlugin.pcm16Bytes(new short[] { 0x1234, -2, Short.MIN_VALUE }, 3);
        assertArrayEquals(new byte[] { 0x34, 0x12, (byte) 0xfe, (byte) 0xff, 0, (byte) 0x80 }, bytes);
    }

    @Test
    public void pcmFrameCanEncodePartialReadWithoutPadding() {
        byte[] bytes = CallAudioPlugin.pcm16Bytes(new short[] { 1, 2, 3 }, 2);
        assertArrayEquals(new byte[] { 1, 0, 2, 0 }, bytes);
    }

    @Test
    public void micLevelIsNormalizedAndSilentFramesStayAtZero() {
        assertEquals(0.0, CallAudioPlugin.normalizedRms(new short[] { 0, 0, 0 }, 3), 0.00001);
        assertEquals(0.5, CallAudioPlugin.normalizedRms(new short[] { 16384, -16384 }, 2), 0.00001);
    }

    @Test
    public void playbackGainMustBeFiniteAndWithinUnitRange() {
        assertTrue(CallAudioPlugin.isValidGain(0));
        assertTrue(CallAudioPlugin.isValidGain(0.5));
        assertTrue(CallAudioPlugin.isValidGain(1));
        assertFalse(CallAudioPlugin.isValidGain(-0.01));
        assertFalse(CallAudioPlugin.isValidGain(1.01));
        assertFalse(CallAudioPlugin.isValidGain(Double.NaN));
        assertFalse(CallAudioPlugin.isValidGain(Double.POSITIVE_INFINITY));
    }
}
