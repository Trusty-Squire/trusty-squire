import { AuthLayout } from "@/components/auth/AuthLayout";
import { SignupStepConnect } from "@/components/auth/SignupStepConnect";

export default function SignupConnectPage() {
  return (
    <AuthLayout title="Connect your coding agent" step={5} totalSteps={5}>
      <SignupStepConnect />
    </AuthLayout>
  );
}
