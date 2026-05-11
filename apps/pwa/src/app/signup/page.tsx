import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepIntro } from "@/components/auth/SignupStepIntro";

export default function SignupPage() {
  return (
    <AuthLayout title="Create your account" step={1} totalSteps={5}>
      <SignupStepIntro />
    </AuthLayout>
  );
}
