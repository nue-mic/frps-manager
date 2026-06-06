package selfupdate

import "testing"

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"1.2.30", "1.2.30", 0},
		{"1.2.30", "1.2.31", -1},
		{"1.2.31", "1.2.30", 1},
		{"v1.2.30", "1.2.31", -1},
		{"1.2.30", "v1.2.30", 0},
		{"1.2.9", "1.2.10", -1},
		{"1.10.0", "1.9.9", 1},
		{"2.0.0", "1.99.99", 1},
		{"1.2.30-rc1", "1.2.30", 0},
		{"1.2", "1.2.0", 0},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestHasUpdate(t *testing.T) {
	if !HasUpdate("1.2.30", "v1.2.31") {
		t.Error("expected update available 1.2.30 -> v1.2.31")
	}
	if HasUpdate("1.2.31", "v1.2.31") {
		t.Error("expected no update when equal")
	}
	if HasUpdate("1.3.0", "v1.2.31") {
		t.Error("expected no update when current is newer")
	}
}

func TestCanSelfUpdate(t *testing.T) {
	if ok, _ := CanSelfUpdate(ModeDocker); ok {
		t.Error("docker must not be self-updatable")
	}
	if ok, _ := CanSelfUpdate(ModeManual); ok {
		t.Error("manual must not be self-updatable")
	}
	if ok, _ := CanSelfUpdate(ModeSystemd); !ok {
		t.Error("systemd should be self-updatable")
	}
}
