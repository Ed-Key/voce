//! Bounded notch resize spring. Retargeting preserves the current velocity.
#[derive(Clone, Copy)]
pub struct Spring {
    pub value: f64,
    pub velocity: f64,
}

impl Spring {
    pub fn new(value: f64) -> Self {
        Self {
            value,
            velocity: 0.0,
        }
    }

    pub fn advance(&mut self, target: f64, elapsed: f64, response: f64, damping: f64) {
        let elapsed = elapsed.clamp(0.0, 0.05);
        let steps = (elapsed / 0.004).ceil().max(1.0) as usize;
        let dt = elapsed / steps as f64;
        let omega = std::f64::consts::TAU / response;
        for _ in 0..steps {
            self.velocity += (-omega * omega * (self.value - target)
                - 2.0 * damping * omega * self.velocity)
                * dt;
            self.value += self.velocity * dt;
        }
    }

    pub fn settled(&self, target: f64) -> bool {
        (self.value - target).abs() < 0.15 && self.velocity.abs() < 1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spring_converges_and_retargets_without_jumping() {
        let mut spring = Spring::new(42.0);
        for _ in 0..10 {
            spring.advance(338.0, 0.016, 0.42, 0.82);
        }
        assert!(spring.value > 42.0 && spring.value < 350.0);
        let before = spring.value;
        spring.advance(42.0, 0.001, 0.45, 1.0);
        assert!((spring.value - before).abs() < 2.0);
        for _ in 0..100 {
            spring.advance(42.0, 0.016, 0.45, 1.0);
        }
        assert!(spring.settled(42.0));
    }

    #[test]
    fn stalled_frame_stays_finite_and_bounded() {
        let mut spring = Spring::new(288.0);
        spring.advance(448.0, 8.0, 0.2, 0.9);
        assert!(spring.value.is_finite() && spring.value > 288.0 && spring.value < 460.0);
    }
}
