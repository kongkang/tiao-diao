#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) { printf("usage: set-output <名称子串> | -c(查当前)\n"); return 1; }
        NSString *target = [NSString stringWithUTF8String:argv[1]];
        AudioObjectPropertyAddress addr = { kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        UInt32 size = 0;
        AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &addr, 0, NULL, &size);
        int count = size / sizeof(AudioDeviceID);
        AudioDeviceID *devs = (AudioDeviceID *)malloc(size);
        AudioObjectGetPropertyData(kAudioObjectSystemObject, &addr, 0, NULL, &size, devs);
        AudioObjectPropertyAddress na = { kAudioDevicePropertyDeviceNameCFString, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
        if ([target isEqualToString:@"-c"]) {
            AudioDeviceID cur; UInt32 cs = sizeof(cur);
            AudioObjectPropertyAddress da = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
            AudioObjectGetPropertyData(kAudioObjectSystemObject, &da, 0, NULL, &cs, &cur);
            for (int i = 0; i < count; i++) if (devs[i] == cur) {
                CFStringRef name; UInt32 ns = sizeof(name);
                AudioObjectGetPropertyData(devs[i], &na, 0, NULL, &ns, &name);
                printf("%s\n", [(__bridge NSString *)name UTF8String]);
            }
            free(devs);
            return 0;
        }
        for (int i = 0; i < count; i++) {
            CFStringRef name; UInt32 ns = sizeof(name);
            AudioObjectGetPropertyData(devs[i], &na, 0, NULL, &ns, &name);
            NSString *n = (__bridge NSString *)name;
            if ([n containsString:target]) {
                AudioObjectPropertyAddress da = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
                OSStatus st = AudioObjectSetPropertyData(kAudioObjectSystemObject, &da, 0, NULL, sizeof(AudioDeviceID), &devs[i]);
                if (st == noErr) { printf("output -> %s\n", [n UTF8String]); free(devs); return 0; }
                fprintf(stderr, "set failed %d\n", st); free(devs); return 2;
            }
        }
        fprintf(stderr, "device not found: %s\n", [target UTF8String]);
        free(devs);
        return 3;
    }
}
